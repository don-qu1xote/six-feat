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

        yandex_mock_bg.search_artist(name, [{"id": yandex_seed_id, "name": name}])
        yandex_mock_bg.artist_tracks(yandex_seed_id, [yandex_track_id])
        yandex_mock_bg.track_artists(
            yandex_track_id,
            [
                {"id": yandex_seed_id, "name": name},
                {"id": yandex_collab_id, "name": "YandexOnlyCollab"},
            ],
        )
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
