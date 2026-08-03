from __future__ import annotations

import requests

from conftest import SERVICE_BASE, GeniusMock, _build_song_detail

GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"

REAL_PHOTO_URL = "https://images.genius.com/1234567890abcdef.1000x1000x1.jpg"

DEFAULT_AVATAR_URL = "https://assets.genius.com/images/default_cover_image.png?1783625229"


class TestDefaultAvatarNormalization:
    def test_default_avatar_yields_empty_image(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
    ) -> None:
        genius_mock.artist(
            unique_artist_id,
            {
                "id": unique_artist_id,
                "name": "No Photo Artist",
                "image": DEFAULT_AVATAR_URL,
            },
        )

        song_id = unique_artist_id * 10 + 1
        collab_id = unique_artist_id * 10 + 2
        genius_mock.songs(unique_artist_id, [song_id])
        genius_mock.song_detail(
            song_id,
            _build_song_detail(
                song_id,
                "Solo Track",
                unique_artist_id,
                "No Photo Artist",
                collaborators=[{"id": collab_id, "name": "Featured Guest", "role": "featured"}],
            ),
        )

        resp = client.get(GRAPH_URL, params={"id": str(unique_artist_id)})
        assert resp.status_code == 200
        data = resp.json()

        seed = next(n for n in data["nodes"] if n["id"] == unique_artist_id)
        assert "image" not in seed, (
            f"expected Genius's default avatar to be normalized away, "
            f"got image={seed.get('image')!r}"
        )

    def test_real_photo_url_is_preserved(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
    ) -> None:
        genius_mock.artist(
            unique_artist_id,
            {
                "id": unique_artist_id,
                "name": "Real Photo Artist",
                "image": REAL_PHOTO_URL,
            },
        )

        song_id = unique_artist_id * 10 + 1
        collab_id = unique_artist_id * 10 + 2
        genius_mock.songs(unique_artist_id, [song_id])
        genius_mock.song_detail(
            song_id,
            _build_song_detail(
                song_id,
                "Solo Track",
                unique_artist_id,
                "Real Photo Artist",
                collaborators=[{"id": collab_id, "name": "Featured Guest", "role": "featured"}],
            ),
        )

        resp = client.get(GRAPH_URL, params={"id": str(unique_artist_id)})
        assert resp.status_code == 200
        data = resp.json()

        seed = next(n for n in data["nodes"] if n["id"] == unique_artist_id)
        assert seed["image"] == REAL_PHOTO_URL
