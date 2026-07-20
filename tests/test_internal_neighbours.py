"""
test_internal_neighbours.py — SF-GAME-13: contract + behavior tests for
six-feat's internal anti-cheat endpoint.

============================================================================
Why this file exists
============================================================================
six-feat-game verifies a player-submitted hop A→B is a REAL collaboration by
calling six-feat's POST /internal/neighbours (see services/game/
neighbours_client.cpp) instead of ever talking to Genius itself — it has no
Genius credentials of its own. Modeled on tests/test_contract_gateway.py
(SF-TST-01): POST directly against the real, compiled six-feat binary
(service_proc — the same process /api/v1/graph already runs on, no separate
fixture needed) using request bodies shaped exactly like
NeighboursClient::Neighbours is documented to send, and assert response
shapes matching what internal_neighbours_handler.cpp's request-parsing/
response-building code actually produces — the two independent sources of
truth this file cross-checks (field names taken from neighbours_client.cpp's
request-building code and internal_neighbours_handler.cpp's request-parsing
code).

TestNeighboursReflectsL1 below additionally exercises the real L1-only read
path end to end: a collaboration is written into L1 exactly like any real
graph request does (client.get(GRAPH_URL, ...) via genius_mock — the same
lazy-fetch CollabService::FindPath itself relies on), then /internal/
neighbours is queried directly, making zero further Genius calls of its own.

Hardcoded small artist ids (matching test_graph.py's own Drake=1/Future=2
convention, not the unique_artist_id fixture) are safe here: clean_db_state
(conftest.py) truncates artists/songs/credits/fetch_state once per test
CLASS whenever service_proc is in the fixture graph — both classes below
pull it in transitively via the `client` fixture — so as long as the ids
used by TestNeighboursReflectsL1's two tests don't collide with each other
(they don't; disjoint ranges below), collisions with other test files' own
hardcoded ids in other classes are a non-issue.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import requests

from conftest import SERVICE_BASE, TEST_ENRICHMENT_INTERNAL_SECRET, GeniusMock, _build_song_detail

# [SF-GAME-13] Same header internal_neighbours_handler.cpp checks on every
# inbound call and neighbours_client.cpp sets on every outbound one
# (internal_auth::kSecretHeader) — reusing ENRICHMENT_INTERNAL_SECRET as the
# whole internal mesh's shared secret, same convention genius-gateway's own
# internal API already established.
INTERNAL_SECRET_HEADER = "X-Internal-Secret"

NEIGHBOURS_URL = f"{SERVICE_BASE}/internal/neighbours"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"


def _collab(collab_id: int, name: str, role: str = "featured") -> dict:
    return {"id": collab_id, "name": name, "role": role}


def _post(
    body: Dict[str, Any],
    *,
    secret: Optional[str] = TEST_ENRICHMENT_INTERNAL_SECRET,
) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers[INTERNAL_SECRET_HEADER] = secret
    return requests.post(NEIGHBOURS_URL, json=body, headers=headers, timeout=5.0)


# ─────────────────────────────────────────────────────────────────────────────
# Contract: POST /internal/neighbours — NeighboursClient::Neighbours
# ─────────────────────────────────────────────────────────────────────────────

class TestNeighboursContract:
    def test_unknown_artist_returns_empty_list(self, service_proc):
        """An artist_id six-feat has never seen is a valid request — an
        empty neighbours list, not a 404 (matches FindPath silently not
        expanding through data it doesn't have)."""
        resp = _post({"artist_id": 424242424, "role_mask": 15})
        assert resp.status_code == 200
        assert resp.json() == {"neighbours": []}

    def test_role_mask_is_optional(self, service_proc):
        """Same "no filter" default ParseRoleMask("") gives every other
        role-aware endpoint — omitting role_mask entirely must not 400."""
        resp = _post({"artist_id": 424242424})
        assert resp.status_code == 200
        assert resp.json() == {"neighbours": []}

    def test_missing_artist_id_is_bad_request(self, service_proc):
        resp = _post({"role_mask": 15})
        assert resp.status_code == 400

    def test_zero_artist_id_is_bad_request(self, service_proc):
        resp = _post({"artist_id": 0})
        assert resp.status_code == 400

    def test_negative_artist_id_is_bad_request(self, service_proc):
        resp = _post({"artist_id": -1})
        assert resp.status_code == 400

    def test_wrong_secret_is_unauthorized(self, service_proc):
        resp = _post({"artist_id": 1}, secret="not-the-real-secret")
        assert resp.status_code == 401

    def test_missing_secret_is_unauthorized(self, service_proc):
        resp = _post({"artist_id": 1}, secret=None)
        assert resp.status_code == 401

    def test_malformed_json_body_is_bad_request(self, service_proc):
        resp = requests.post(
            NEIGHBOURS_URL,
            data="{not json",
            headers={
                "Content-Type": "application/json",
                INTERNAL_SECRET_HEADER: TEST_ENRICHMENT_INTERNAL_SECRET,
            },
            timeout=5.0,
        )
        assert resp.status_code == 400

    def test_wrong_field_name_is_bad_request(self, service_proc):
        """Pins the exact key ("artist_id") the client/handler agree on —
        sending "id" instead must NOT silently succeed."""
        resp = _post({"id": 1})
        assert resp.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# Behavior: known collaboration appears, isolated artist does not
# ─────────────────────────────────────────────────────────────────────────────

class TestNeighboursReflectsL1:
    _A_ID = 130_001
    _B_ID = 130_002
    _C_ID = 130_003

    def test_known_collaboration_appears_in_neighbours(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve(
            "SFGAME13ArtistA", [{"id": self._A_ID, "name": "SFGAME13ArtistA", "score": 0.99}]
        )
        genius_mock.songs(self._A_ID, [130_101])
        genius_mock.song_detail(
            130_101,
            _build_song_detail(
                130_101, "SF-GAME-13 Collab Song", self._A_ID, "SFGAME13ArtistA",
                collaborators=[_collab(self._B_ID, "SFGAME13ArtistB")],
            ),
        )

        # Writes A/B and their collaboration into L1 — the same lazy-fetch
        # path CollabService::FindPath itself relies on. Nothing below this
        # point touches genius_mock again.
        graph_resp = client.get(GRAPH_URL, params={"artist": "SFGAME13ArtistA"})
        assert graph_resp.status_code == 200

        resp = _post({"artist_id": self._A_ID, "role_mask": 15})
        assert resp.status_code == 200
        assert self._B_ID in resp.json()["neighbours"]

    def test_isolated_artist_has_no_neighbours(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        genius_mock.resolve(
            "SFGAME13ArtistC", [{"id": self._C_ID, "name": "SFGAME13ArtistC", "score": 0.99}]
        )
        genius_mock.songs(self._C_ID, [])

        graph_resp = client.get(GRAPH_URL, params={"artist": "SFGAME13ArtistC"})
        assert graph_resp.status_code == 200

        resp = _post({"artist_id": self._C_ID, "role_mask": 15})
        assert resp.status_code == 200
        assert resp.json() == {"neighbours": []}
