"""
test_trace_id.py — SF-OBS-02 regression: a single request/trace id must
survive the six-feat -> six-feat-genius-gateway -> Genius hop.

Chain under test (all real processes, per conftest.py's default profile):
  client -> six-feat (service_proc)     — echoes X-Request-Id in its own
                                           response (EnsureRequestId, called
                                           by graph_handler.cpp)
         -> six-feat-genius-gateway (genius_gateway_proc, real binary)
            -> surrogate Genius server (mock_server) — GeniusGateway::GeniusGet
               forwards X-Request-Id on every outbound call

Before the EnsureRequestId(request) fix in
libs/six-feat-common/src/core/request_id.cpp, every hop ignored any incoming
X-Request-Id header and minted its own span trace id instead, so the id
genius-gateway forwarded to Genius never matched the id six-feat itself
reported back to the client — this test fails against that old behaviour.
"""

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

        artist_calls = [
            c for c in mock_server.calls
            if c["path"] == f"/artists/{unique_artist_id}"
        ]
        assert artist_calls, "genius-gateway never reached the surrogate Genius server"

        forwarded_id = artist_calls[-1]["request_id"]
        assert forwarded_id == request_id, (
            "genius-gateway forwarded a different X-Request-Id to Genius "
            f"({forwarded_id!r}) than six-feat reported to the client "
            f"({request_id!r}) — the trace id was not propagated end-to-end"
        )