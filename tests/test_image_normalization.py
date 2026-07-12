"""
test_image_normalization.py — SF-API-07 regression.

Genius's own fallback avatar for an artist with no uploaded photo is a
real, resolvable image URL (not a 404 or empty string) — confirmed against
a live response: https://assets.genius.com/images/default_cover_image.png
?1783625229 (filename is `default_cover_image.png` with a cache-busting
query string, NOT `default_avatar_*.png`) — so it can't be told apart
from a real photo by validity alone. Before this fix,
GeniusGateway (libs/six-feat-common/src/genius/genius_gateway.cpp) passed
that URL straight through into ArtistRef::image, so the front end rendered
Genius's grey placeholder instead of its own themed one (front/src/state/
helpers.js placeholderFor, used everywhere as `imageUrl ||
placeholderFor(...)`, which only kicks in on an empty string).

These tests exercise the real six-feat -> six-feat-genius-gateway chain
(via the surrogate Genius server, same as test_graph.py) and assert:
  - a default-avatar image_url is normalized away — the response node
    carries no "image" field at all (graph_handler.cpp omits the key
    entirely when ArtistRef::image is empty — see nb["image"] = ... only
    inside `if (!data.seed.image.empty())`).
  - a real photo URL survives untouched.
"""

from __future__ import annotations

import requests

from conftest import SERVICE_BASE, GeniusMock

GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"

# A real, resolvable Genius URL — not the pattern under test.
REAL_PHOTO_URL = "https://images.genius.com/1234567890abcdef.1000x1000x1.jpg"

# Genius's actual fallback avatar for artists with no photo — matches
# GeniusGateway's kGeniusDefaultAvatarMarker ("default_cover_image")
# regardless of host/query-string. This is the real filename Genius serves,
# confirmed against a live response — NOT "default_avatar_*.png".
DEFAULT_AVATAR_URL = "https://assets.genius.com/images/default_cover_image.png?1783625229"


class TestDefaultAvatarNormalization:
    def test_default_avatar_yields_empty_image(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        unique_artist_id: int,
    ) -> None:
        genius_mock.artist(unique_artist_id, {
            "id": unique_artist_id, "name": "No Photo Artist",
            "image": DEFAULT_AVATAR_URL,
        })
        genius_mock.songs(unique_artist_id, [])

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
        genius_mock.artist(unique_artist_id, {
            "id": unique_artist_id, "name": "Real Photo Artist",
            "image": REAL_PHOTO_URL,
        })
        genius_mock.songs(unique_artist_id, [])

        resp = client.get(GRAPH_URL, params={"id": str(unique_artist_id)})
        assert resp.status_code == 200
        data = resp.json()

        seed = next(n for n in data["nodes"] if n["id"] == unique_artist_id)
        assert seed["image"] == REAL_PHOTO_URL