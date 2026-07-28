"""
test_contract_gateway.py — SF-TST-01: contract tests for the six-feat
internal Genius-gateway API.

============================================================================
Why this file exists
============================================================================
six-feat and six-feat-enrichment both embed the SAME client component
(GeniusGatewayClient, libs/six-feat-genius/src/genius_gateway_client.cpp
— see that file's own header comment: "replaces the in-process GeniusGateway
component for six_feat and six_feat_enrichment") to call the standalone
six-feat-genius-gateway service's internal API:

    POST /internal/genius/artist       {id, lane, user_token}       -> {found, id?, name?, image?, url?}
    POST /internal/genius/song-list    {artist_id, limit, lane, user_token} -> {song_ids: [int]}
    POST /internal/genius/song         {song_id, lane, user_token}  -> {found, song?: {id, title, popularity, credits: [{artist: {id,name,image,url}, role}]}}
    POST /internal/genius/candidates   {query, user_token}          -> {candidates: [{id, name, image, url, score}]}

(field names taken from genius_gateway_client.cpp's request-building code and
services/genius-gateway/internal_handlers.cpp's request-parsing code — the
two independent sources of truth this file cross-checks.)

Until now this contract was only ever exercised indirectly, as a side effect
of full graph/search/path end-to-end tests (test_graph.py etc.) — a field
rename on either side surfaces there as a confusing 502 "genius_error"
several call-frames away from the actual cause (see
test_genius_http_mock.py's header comment for a very similar previously-real
regression one layer up the stack, at the Genius-API-mock level).

These tests instead POST directly to the REAL, compiled six-feat-genius-
gateway binary (genius_gateway_proc — no new runtime: this fixture and its
mock_server/genius_mock dependency already exist and already back every
other integration test in this suite) using request bodies built exactly to
the shape genius_gateway_client.cpp is documented to send, and assert
response shapes exactly matching what its parsing code (FetchArtistById /
FetchSongList / FetchSongDetail / ResolveCandidates) reads back out. Because
GeniusGatewayClient is the one shared component both six-feat and
six-feat-enrichment link against, pinning the server's contract here also
pins it for both callers — there's no separate enrichment-side copy of this
serialization code to test again.

A genuine field-name desync between the client and the gateway (e.g. the
gateway starts expecting "artistId" while the client still sends
"artist_id") makes the corresponding test below fail directly and
specifically, instead of surfacing only as an opaque downstream 502.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import requests

from conftest import (
    GENIUS_GATEWAY_BASE,
    TEST_ENRICHMENT_INTERNAL_SECRET,
    _build_song_detail,
)

INTERNAL_SECRET_HEADER = "X-Internal-Secret"


def _post(
    path: str,
    body: Dict[str, Any],
    *,
    secret: Optional[str] = TEST_ENRICHMENT_INTERNAL_SECRET,
) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers[INTERNAL_SECRET_HEADER] = secret
    return requests.post(f"{GENIUS_GATEWAY_BASE}{path}", json=body, headers=headers, timeout=5.0)


class TestArtistContract:
    def test_request_shape_is_accepted_and_response_matches_client_parsing(
        self, genius_gateway_proc, genius_mock
    ):
        genius_mock.artist(
            555,
            {
                "id": 555,
                "name": "Contract Artist",
                "image": "http://img.example/a.jpg",
                "url": "http://genius.com/artists/555",
            },
        )

        resp = _post(
            "/internal/genius/artist",
            {"id": 555, "lane": "foreground", "user_token": "tok"},
        )

        assert resp.status_code == 200
        body = resp.json()

        assert body == {
            "found": True,
            "id": 555,
            "name": "Contract Artist",
            "image": "http://img.example/a.jpg",
            "url": "http://genius.com/artists/555",
        }

    def test_background_lane_string_is_accepted(self, genius_gateway_proc, genius_mock):
        genius_mock.artist(556, {"id": 556, "name": "BG Artist"})
        resp = _post(
            "/internal/genius/artist",
            {"id": 556, "lane": "background", "user_token": "tok"},
        )
        assert resp.status_code == 200
        assert resp.json()["found"] is True

    def test_not_found_response_shape(self, genius_gateway_proc):
        resp = _post(
            "/internal/genius/artist",
            {"id": 9_999_999, "lane": "foreground", "user_token": "tok"},
        )
        assert resp.status_code == 200

        assert resp.json() == {"found": False}

    def test_missing_user_token_is_bad_request(self, genius_gateway_proc):
        resp = _post("/internal/genius/artist", {"id": 1, "lane": "foreground"})
        assert resp.status_code == 400

    def test_unrecognized_lane_value_is_bad_request(self, genius_gateway_proc):
        resp = _post(
            "/internal/genius/artist",
            {"id": 1, "lane": "sideways", "user_token": "tok"},
        )
        assert resp.status_code == 400

    def test_wrong_field_name_is_rejected(self, genius_gateway_proc):
        """Pins the exact key ("id") FetchArtistById's request-builder uses —
        "artist_id" is the *song-list*/"song_id" is the *song* handler's key,
        not this one. Sending it here must NOT silently succeed."""
        resp = _post(
            "/internal/genius/artist",
            {"artist_id": 1, "lane": "foreground", "user_token": "tok"},
        )
        assert resp.status_code == 400

    def test_wrong_secret_is_unauthorized(self, genius_gateway_proc):
        resp = _post(
            "/internal/genius/artist",
            {"id": 1, "lane": "foreground", "user_token": "tok"},
            secret="not-the-real-secret",
        )
        assert resp.status_code == 401

    def test_malformed_json_body_is_bad_request(self, genius_gateway_proc):
        resp = requests.post(
            f"{GENIUS_GATEWAY_BASE}/internal/genius/artist",
            data="{not json",
            headers={
                "Content-Type": "application/json",
                INTERNAL_SECRET_HEADER: TEST_ENRICHMENT_INTERNAL_SECRET,
            },
            timeout=5.0,
        )
        assert resp.status_code == 400


class TestSongListContract:
    def test_request_shape_is_accepted_and_response_matches_client_parsing(
        self, genius_gateway_proc, genius_mock
    ):
        genius_mock.songs(777, [201, 202, 203])

        resp = _post(
            "/internal/genius/song-list",
            {"artist_id": 777, "limit": 10, "lane": "foreground", "user_token": "tok"},
        )

        assert resp.status_code == 200

        assert resp.json() == {"song_ids": [201, 202, 203]}

    def test_positive_limit_field_is_accepted(self, genius_gateway_proc, genius_mock):
        """limit is forwarded to upstream as a query param (see
        GeniusGateway::FetchSongList's per_page); the mock Genius server
        doesn't itself honor per_page (see genius_mock.songs — it always
        returns every programmed id), so this only pins that the field is
        accepted and doesn't change the response *shape* — actual
        truncation is exercised end-to-end elsewhere (test_graph.py)."""
        genius_mock.songs(778, [301, 302, 303])
        resp = _post(
            "/internal/genius/song-list",
            {"artist_id": 778, "limit": 2, "lane": "foreground", "user_token": "tok"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"song_ids": [301, 302, 303]}

    def test_omitted_limit_field_falls_back_without_erroring(
        self, genius_gateway_proc, genius_mock
    ):
        """limit<=0 (including omitted, which parses to 0) falls back to the
        gateway's own songs-limit-fg/bg config (see SongListHandler) instead
        of being a required client-side field — must not 400."""
        genius_mock.songs(779, [901, 902])
        resp = _post(
            "/internal/genius/song-list",
            {"artist_id": 779, "lane": "foreground", "user_token": "tok"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"song_ids": [901, 902]}

    def test_missing_artist_id_is_bad_request(self, genius_gateway_proc):
        resp = _post(
            "/internal/genius/song-list",
            {"limit": 10, "lane": "foreground", "user_token": "tok"},
        )
        assert resp.status_code == 400

    def test_wrong_secret_is_unauthorized(self, genius_gateway_proc):
        resp = _post(
            "/internal/genius/song-list",
            {"artist_id": 1, "limit": 10, "lane": "foreground", "user_token": "tok"},
            secret="not-the-real-secret",
        )
        assert resp.status_code == 401


class TestSongContract:
    def test_request_shape_is_accepted_and_response_matches_client_parsing(
        self, genius_gateway_proc, genius_mock
    ):
        genius_mock.song_detail(
            401,
            _build_song_detail(
                401,
                "Contract Song",
                1,
                "Primary Artist",
                collaborators=[{"id": 2, "name": "Featured Artist", "role": "featured"}],
                popularity=42,
            ),
        )

        resp = _post(
            "/internal/genius/song",
            {"song_id": 401, "lane": "foreground", "user_token": "tok"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["found"] is True
        song = body["song"]

        assert song["id"] == 401
        assert song["title"] == "Contract Song"
        assert song["popularity"] == 42
        roles_by_artist_id = {c["artist"]["id"]: c["role"] for c in song["credits"]}
        assert roles_by_artist_id == {1: "primary", 2: "featured"}
        primary_credit = next(c for c in song["credits"] if c["artist"]["id"] == 1)
        assert primary_credit["artist"]["name"] == "Primary Artist"

    def test_not_found_response_shape(self, genius_gateway_proc):
        resp = _post(
            "/internal/genius/song",
            {"song_id": 9_999_999, "lane": "foreground", "user_token": "tok"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"found": False}

    def test_missing_song_id_is_bad_request(self, genius_gateway_proc):
        resp = _post("/internal/genius/song", {"lane": "foreground", "user_token": "tok"})
        assert resp.status_code == 400

    def test_wrong_secret_is_unauthorized(self, genius_gateway_proc):
        resp = _post(
            "/internal/genius/song",
            {"song_id": 1, "lane": "foreground", "user_token": "tok"},
            secret="not-the-real-secret",
        )
        assert resp.status_code == 401


class TestCandidatesContract:
    def test_request_shape_is_accepted_and_response_matches_client_parsing(
        self, genius_gateway_proc, genius_mock
    ):

        genius_mock.resolve(
            "Match One",
            [
                {
                    "id": 1,
                    "name": "Match One",
                    "image": "http://img/1.jpg",
                    "url": "http://genius.com/1",
                }
            ],
        )

        resp = _post(
            "/internal/genius/candidates",
            {"query": "Match One", "user_token": "tok"},
        )

        assert resp.status_code == 200

        assert resp.json() == {
            "candidates": [
                {
                    "id": 1,
                    "name": "Match One",
                    "image": "http://img/1.jpg",
                    "url": "http://genius.com/1",
                    "score": 1.0,
                }
            ]
        }

    def test_empty_result_is_a_valid_response(self, genius_gateway_proc, genius_mock):
        genius_mock.resolve_empty("No Matches Query")
        resp = _post(
            "/internal/genius/candidates",
            {"query": "No Matches Query", "user_token": "tok"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"candidates": []}

    def test_missing_query_is_bad_request(self, genius_gateway_proc):
        resp = _post("/internal/genius/candidates", {"user_token": "tok"})
        assert resp.status_code == 400

    def test_missing_user_token_is_bad_request(self, genius_gateway_proc):
        resp = _post("/internal/genius/candidates", {"query": "Anything"})
        assert resp.status_code == 400

    def test_wrong_secret_is_unauthorized(self, genius_gateway_proc):
        resp = _post(
            "/internal/genius/candidates",
            {"query": "Anything", "user_token": "tok"},
            secret="not-the-real-secret",
        )
        assert resp.status_code == 401
