"""
test_enrichment_provider_preference.py — end-to-end coverage for SF-YM-07's
preferred_enrichment_provider actually changing which upstream (Yandex vs
Genius) wins inside the real, running EnrichmentWorker.
============================================================================

SF-YM-07 threaded `preferred_provider` end-to-end (settings handler ->
CollabService -> EnrichmentClient -> /internal/enqueue -> EnrichmentWorker ->
MusicSourceProviderChain::OrderedProviders), but the original commit only
verified it up to the HTTP wire format — nothing exercised the real
background worker with two genuinely competing providers and checked which
one's data actually ends up persisted.

Technique: hit six-feat-enrichment's /internal/enqueue directly (same
direct-internal-API pattern as test_graceful_drain.py), bypassing six-feat's
own live /api/v1/graph endpoint entirely. This matters because
CollabService::FetchFg (the live/foreground fetch) always uses the chain's
default order regardless of any preference, and ArtistRepository's upserts
are additive — so triggering the live path first would silently merge its
(always yandex-first) result with whatever the background job later picks,
making it impossible to attribute the observed graph to one provider.
By only ever going through /internal/enqueue for this seed, the only writer
of its data is the background job under test.

Once /internal/status reports Depth::Full, /api/v1/graph?id=... is read
through a Yandex-only session — per SF-YM-08, an already-fully-cached
artist is servable by id without a Genius token, so this read also never
touches the live path (network_needed=false), and the persisted graph
reflects exclusively the background job's provider choice.

Both providers are set up with a real, non-empty answer for the same seed,
each with its own distinct collaborator — TrySongsProvidersInOrder returns
the FIRST non-empty answer outright, so whichever provider is ordered first
wins completely, never merging with the other's data. edge["source"]
("yandex_feature" vs "genius_credit") is an additional, unambiguous
provider-specific signal derived from the persisted song id's namespace.
"""

from __future__ import annotations

import sys
import time
import uuid
from pathlib import Path

import pytest
import requests
from conftest import (
    ENRICHMENT_BASE_BG,
    SERVICE_BASE_BG,
    TEST_APP_SECRET,
    TEST_ENRICHMENT_INTERNAL_SECRET,
    GeniusMock,
    YandexMock,
    _build_song_detail,
)

sys.path.insert(0, str(Path(__file__).parent))
import session_crypto  # noqa: E402

pytestmark = pytest.mark.bg_profile

GRAPH_URL_BG = f"{SERVICE_BASE_BG}/api/v1/graph"

_SECRET_HEADER = {"X-Internal-Secret": TEST_ENRICHMENT_INTERNAL_SECRET}


def _collab(collab_id: int, name: str, role: str = "featured") -> dict:
    return {"id": collab_id, "name": name, "role": role}


def _yandex_only_session() -> requests.Session:
    """Как _yandex_session() в test_graph.py — сессия с яндексовым
    access_token (не Genius), несущим свой собственный user_id, независимый
    от enqueue-запросов ниже (те идут напрямую в /internal/enqueue, вообще
    без сессии — preferred_provider там передаётся явно в теле)."""
    sess = requests.Session()
    sess.headers["Accept"] = "application/json"
    cookie = session_crypto.make_cookie(
        TEST_APP_SECRET,
        access_token="yandex-session-token-not-valid-for-genius",
        name="",
        provider="yandex",
        provider_user_id=f"yandex-uid-{uuid.uuid4().hex}",
    )
    sess.cookies.update({"six_feat_session": cookie})
    return sess


def _enqueue(artist_id: int, name: str, preferred_provider: str) -> requests.Response:
    return requests.post(
        f"{ENRICHMENT_BASE_BG}/internal/enqueue",
        json={
            "artist_id": artist_id,
            "name": name,
            "user_token": "test-token",
            "preferred_provider": preferred_provider,
        },
        headers=_SECRET_HEADER,
        timeout=5,
    )


def _wait_for_full_depth(artist_id: int, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        resp = requests.get(
            f"{ENRICHMENT_BASE_BG}/internal/status",
            params={"id": str(artist_id)},
            headers=_SECRET_HEADER,
            timeout=5,
        )
        resp.raise_for_status()
        last = resp.json()
        if last["depth"] >= 2:
            return last
        time.sleep(0.05)
    raise AssertionError(f"artist {artist_id} never reached Depth::Full: {last}")


class TestEnrichmentProviderPreferenceAffectsBackgroundWorker:
    """[SF-YM-07] preferred_provider actually changes which upstream wins
    inside the real EnrichmentWorker, per background job — not just
    threaded through the wire format."""

    def _setup_competing_providers(
        self,
        genius_mock_bg: GeniusMock,
        yandex_mock_bg: YandexMock,
        *,
        artist_id: int,
        name: str,
    ) -> dict:
        yandex_seed_id = artist_id + 1
        yandex_collab_id = artist_id + 2
        yandex_track_id = artist_id + 3
        genius_song_id = artist_id * 1000 + 1
        genius_collab_id = artist_id + 4
        genius_id_of_yandex_collab = artist_id + 5

        # Genius side: a real, non-empty answer of its own.
        genius_mock_bg.songs(artist_id, [genius_song_id])
        genius_mock_bg.song_detail(
            genius_song_id,
            _build_song_detail(
                genius_song_id,
                "Genius Exclusive Song",
                artist_id,
                name,
                collaborators=[_collab(genius_collab_id, "GeniusOnlyCollab")],
            ),
        )

        # Yandex side: a different, real, non-empty answer.
        yandex_mock_bg.search_artist(name, [{"id": yandex_seed_id, "name": name}])
        yandex_mock_bg.artist_tracks(yandex_seed_id, [yandex_track_id])
        yandex_mock_bg.track_artists(
            yandex_track_id,
            [
                {"id": yandex_seed_id, "name": name},
                {"id": yandex_collab_id, "name": "YandexOnlyCollab"},
            ],
        )
        # YandexMusicSourceProvider always resolves a discovered co-artist's
        # NAME into the shared Genius-id namespace, even on the "Yandex path".
        genius_mock_bg.resolve(
            "YandexOnlyCollab",
            [{"id": genius_id_of_yandex_collab, "name": "YandexOnlyCollab", "score": 0.95}],
        )

        return {
            "genius_collab_id": genius_collab_id,
            "yandex_collab_id": genius_id_of_yandex_collab,
        }

    def test_genius_preference_makes_genius_win(
        self,
        service_proc_bg,
        genius_mock_bg: GeniusMock,
        yandex_mock_bg: YandexMock,
        unique_artist_id: int,
    ):
        artist_id = unique_artist_id
        name = f"PrefGenius{artist_id}"
        ids = self._setup_competing_providers(
            genius_mock_bg, yandex_mock_bg, artist_id=artist_id, name=name
        )

        resp = _enqueue(artist_id, name, preferred_provider="genius")
        assert resp.status_code == 202 and resp.json()["enqueued"] is True

        _wait_for_full_depth(artist_id)

        sess = _yandex_only_session()
        graph = sess.get(GRAPH_URL_BG, params={"id": str(artist_id)}).json()

        assert graph["seed_id"] == artist_id
        node_ids = {n["id"] for n in graph["nodes"]}
        assert ids["genius_collab_id"] in node_ids
        assert ids["yandex_collab_id"] not in node_ids
        assert graph["edges"]
        assert all(e["source"] == "genius_credit" for e in graph["edges"])

    def test_default_preference_makes_yandex_win(
        self,
        service_proc_bg,
        genius_mock_bg: GeniusMock,
        yandex_mock_bg: YandexMock,
        unique_artist_id: int,
    ):
        artist_id = unique_artist_id
        name = f"PrefDefault{artist_id}"
        ids = self._setup_competing_providers(
            genius_mock_bg, yandex_mock_bg, artist_id=artist_id, name=name
        )

        resp = _enqueue(artist_id, name, preferred_provider="")
        assert resp.status_code == 202 and resp.json()["enqueued"] is True

        _wait_for_full_depth(artist_id)

        sess = _yandex_only_session()
        graph = sess.get(GRAPH_URL_BG, params={"id": str(artist_id)}).json()

        assert graph["seed_id"] == artist_id
        node_ids = {n["id"] for n in graph["nodes"]}
        assert ids["yandex_collab_id"] in node_ids
        assert ids["genius_collab_id"] not in node_ids
        assert graph["edges"]
        assert all(e["source"] == "yandex_feature" for e in graph["edges"])
