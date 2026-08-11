from __future__ import annotations

import requests

from conftest import SERVICE_BASE, GeniusMock

GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"


class TestTraceIdPropagation:
    def test_same_request_id_reaches_genius_gateway_and_genius(
        self,
        client: requests.Session,
        genius_mock: GeniusMock,
        mock_server,
        unique_artist_id: int,
    ) -> None:
        genius_mock.artist(unique_artist_id, {"id": unique_artist_id, "name": "Trace Test Artist"})
        genius_mock.songs(unique_artist_id, [])

        resp = client.get(GRAPH_URL, params={"id": str(unique_artist_id)})
        assert resp.status_code == 200

        request_id = resp.headers.get("X-Request-Id")
        assert request_id, "six-feat did not echo an X-Request-Id response header"

        artist_calls = [c for c in mock_server.calls if c["path"] == f"/artists/{unique_artist_id}"]
        assert artist_calls, "genius-gateway never reached the surrogate Genius server"

        forwarded_id = artist_calls[-1]["request_id"]
        assert forwarded_id == request_id, (
            "genius-gateway forwarded a different X-Request-Id to Genius "
            f"({forwarded_id!r}) than six-feat reported to the client "
            f"({request_id!r}) — the trace id was not propagated end-to-end"
        )
