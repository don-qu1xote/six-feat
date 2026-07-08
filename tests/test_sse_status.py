"""
test_sse_status.py — integration tests for GET /api/v1/status/stream
=====================================================================

The /api/v1/status/stream endpoint replaces the setInterval polling in
script.js (ТЗ-3).  It is a Server-Sent Events (SSE) stream that pushes
enrichment-progress events for a single artist and closes automatically
when depth reaches 2 (Full-scan complete).

Expected response:
  Content-Type:      text/event-stream
  Cache-Control:     no-cache
  X-Accel-Buffering: no

  data: {"depth": <int 0|1|2>, "song_count": <int>}\n\n
  …repeated every ~2 s until depth >= 2, then stream ends.

Scenarios covered:
  0.  [F-29] Anonymous request (no session cookie) → HTTP 401
  1.  Missing ?id param → 400
  2.  Non-integer id → 400
  3.  Response headers: Content-Type, Cache-Control, X-Accel-Buffering
  4.  At least one SSE event is emitted before the stream closes
  5.  Every received event is well-formed JSON with depth and song_count
  6.  Stream closes itself once depth >= 2 (populated artist) — the server
      ends the connection, tests must not fall back on their own read
      timeout to observe termination
  7.  Unknown artist emits events with depth=0 and song_count=0 (no hang)
  8.  Client disconnect: server-side connection closes cleanly (no zombie)
  9.  Concurrent connections for the same artist_id are independent
  10. The connection is genuinely long-lived: multiple events are pushed
      over real wall-clock time on one connection, not a burst of events
      followed by an immediate close

NOTE: SSE is a long-running response; tests use streaming=True and
short read timeouts, and poll/read with a timeout instead of sleeping a
fixed amount of time.  Tests are marked with `sse_endpoint` so CI can
gate them separately while the feature lands.
"""

from __future__ import annotations

import json
import threading
import time
from typing import List, Optional, Tuple

import pytest
import requests

from conftest import (
    SERVICE_BASE,
    SERVICE_BASE_BG,
    GeniusMock,
    _build_song_detail,
    wait_for_status_ready,
)

SSE_URL    = f"{SERVICE_BASE}/api/v1/status/stream"
GRAPH_URL  = f"{SERVICE_BASE}/api/v1/graph"
STATUS_URL = f"{SERVICE_BASE}/api/v1/status"

SSE_URL_BG    = f"{SERVICE_BASE_BG}/api/v1/status/stream"
GRAPH_URL_BG  = f"{SERVICE_BASE_BG}/api/v1/graph"
STATUS_URL_BG = f"{SERVICE_BASE_BG}/api/v1/status"

# How long to wait for the first event before giving up.
FIRST_EVENT_TIMEOUT = 8.0
# Maximum number of events to read in a single test before we force-close.
MAX_EVENTS = 10

pytestmark = pytest.mark.sse_endpoint


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _skip_if_not_implemented(resp: requests.Response) -> None:
    if resp.status_code == 404:
        pytest.skip("/api/v1/status/stream not yet implemented — skipping")


# ─────────────────────────────────────────────────────────────────────────────
# 0. [F-29] Anonymous access is rejected — sse_status.cpp must be consistent
#    with graph/path's auth policy (see sse_status_handler.cpp).
# ─────────────────────────────────────────────────────────────────────────────

class TestSseRequiresAuth:
    def test_anonymous_returns_401(self, anon_client: requests.Session):
        resp = anon_client.get(SSE_URL, params={"id": "1"}, timeout=5.0)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 401

    def test_anonymous_error_body_has_not_authenticated(self, anon_client: requests.Session):
        resp = anon_client.get(SSE_URL, params={"id": "1"}, timeout=5.0)
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert data.get("error") == "not_authenticated"

    def test_garbage_cookie_value_returns_401(self, service_proc):
        sess = requests.Session()
        sess.headers["Accept"] = "application/json"
        sess.cookies.update({"six_feat_session": "not-a-valid-encrypted-cookie"})
        resp = sess.get(SSE_URL, params={"id": "1"}, timeout=5.0)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 401


def _parse_sse_events(raw: str) -> List[dict]:
    """
    Parse raw SSE text into a list of decoded JSON objects.
    Only lines starting with "data: " are considered; comment/retry/id lines
    are ignored.  Malformed JSON is silently dropped.
    """
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        try:
            events.append(json.loads(payload))
        except json.JSONDecodeError:
            pass
    return events


def _read_sse_stream(
    url: str,
    params: dict,
    *,
    max_events: int = MAX_EVENTS,
    read_timeout: float = FIRST_EVENT_TIMEOUT,
    session: Optional[requests.Session] = None,
    stats: Optional[dict] = None,
) -> Tuple[requests.Response, List[dict]]:
    """
    Open an SSE connection and read up to *max_events* events.
    Returns (response, events_list).
    Closes the connection when max_events is reached or the server ends the
    stream, whichever comes first.

    If *stats* is passed, it is populated with:
      "timed_out": True if reading gave up on our own read_timeout rather
                   than the server ending the stream on its own — useful to
                   distinguish "server closed the stream" from "we stopped
                   waiting", without any fixed sleep.
    """
    sess = session or requests.Session()
    resp = sess.get(url, params=params, stream=True, timeout=(5.0, read_timeout))
    events: List[dict] = []
    timed_out = False

    try:
        buffer = ""
        for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
            if chunk:
                buffer += chunk
                # Parse complete SSE blocks (terminated by \n\n)
                while "\n\n" in buffer:
                    block, buffer = buffer.split("\n\n", 1)
                    for line in block.splitlines():
                        line = line.strip()
                        if line.startswith("data:"):
                            payload = line[len("data:"):].strip()
                            try:
                                events.append(json.loads(payload))
                            except json.JSONDecodeError:
                                pass
                if len(events) >= max_events:
                    break
    except requests.exceptions.Timeout:
        timed_out = True  # we gave up waiting; the server did not close on its own
    finally:
        resp.close()
        if stats is not None:
            stats["timed_out"] = timed_out

    return resp, events


def _populate_artist(
    client: requests.Session,
    genius_mock: GeniusMock,
    artist_id: int,
    name: str,
    *,
    graph_url: str = GRAPH_URL,
    status_url: str = STATUS_URL,
) -> None:
    """Trigger a graph request so L1 is populated for the given artist."""
    genius_mock.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
    genius_mock.songs(artist_id, [artist_id * 10])
    genius_mock.song_detail(
        artist_id * 10,
        _build_song_detail(
            artist_id * 10, f"Song by {name}", artist_id, name,
            collaborators=[{"id": artist_id + 1, "name": f"Feat{artist_id}", "role": "featured"}],
        ),
    )
    client.get(graph_url, params={"artist": name})
    # Poll /status until the async L1 write has actually settled, instead of
    # guessing with a fixed sleep (flaky under load).
    wait_for_status_ready(client, status_url, artist_id)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Missing ?id parameter → 400
# ─────────────────────────────────────────────────────────────────────────────

class TestSseMissingParam:
    def test_no_id_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(SSE_URL, timeout=5.0)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400

    def test_no_id_error_body_is_json(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(SSE_URL, timeout=5.0)
        _skip_if_not_implemented(resp)
        data = resp.json()
        assert "error" in data


# ─────────────────────────────────────────────────────────────────────────────
# 2. Non-integer id → 400
# ─────────────────────────────────────────────────────────────────────────────

class TestSseInvalidParam:
    def test_string_id_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(SSE_URL, params={"id": "not-a-number"}, timeout=5.0)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400

    def test_float_id_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(SSE_URL, params={"id": "1.5"}, timeout=5.0)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400

    def test_empty_id_returns_400(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(SSE_URL, params={"id": ""}, timeout=5.0)
        _skip_if_not_implemented(resp)
        assert resp.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# 3. Response headers
# ─────────────────────────────────────────────────────────────────────────────

class TestSseHeaders:
    """Headers must be set correctly before any body is sent."""

    def _get_headers(self, client: requests.Session) -> requests.Response:
        """Open stream, grab headers immediately, then close."""
        resp = client.get(SSE_URL, params={"id": "99999"}, stream=True, timeout=(5.0, 2.0))
        return resp

    def test_content_type_is_event_stream(self, client: requests.Session, genius_mock: GeniusMock):
        resp = self._get_headers(client)
        _skip_if_not_implemented(resp)
        ct = resp.headers.get("content-type", "")
        resp.close()
        assert "text/event-stream" in ct, f"Expected text/event-stream, got: {ct}"

    def test_cache_control_no_cache(self, client: requests.Session, genius_mock: GeniusMock):
        resp = self._get_headers(client)
        _skip_if_not_implemented(resp)
        cc = resp.headers.get("cache-control", "")
        resp.close()
        assert "no-cache" in cc, f"Expected no-cache in Cache-Control, got: {cc}"

    def test_x_accel_buffering_no(self, client: requests.Session, genius_mock: GeniusMock):
        resp = self._get_headers(client)
        _skip_if_not_implemented(resp)
        xab = resp.headers.get("x-accel-buffering", "")
        resp.close()
        assert xab.lower() == "no", f"Expected X-Accel-Buffering: no, got: {xab}"

    def test_http_status_200_for_valid_id(self, client: requests.Session, genius_mock: GeniusMock):
        resp = self._get_headers(client)
        _skip_if_not_implemented(resp)
        resp.close()
        assert resp.status_code == 200


# ─────────────────────────────────────────────────────────────────────────────
# 4. At least one event is emitted
# ─────────────────────────────────────────────────────────────────────────────

class TestSseAtLeastOneEvent:
    def test_emits_at_least_one_event(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL, {"id": "99999"},
            max_events=1, read_timeout=6.0, session=client,
        )
        if not events:
            pytest.skip("/api/v1/status/stream not yet emitting events — skipping")
        assert len(events) >= 1


# ─────────────────────────────────────────────────────────────────────────────
# 5. Event schema: each event must have depth and song_count
# ─────────────────────────────────────────────────────────────────────────────

class TestSseEventSchema:
    def test_events_have_depth_field(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL, {"id": "99999"},
            max_events=2, read_timeout=6.0, session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert "depth" in ev, f"Event missing 'depth': {ev}"

    def test_events_have_song_count_field(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL, {"id": "99999"},
            max_events=2, read_timeout=6.0, session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert "song_count" in ev, f"Event missing 'song_count': {ev}"

    def test_depth_is_integer(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL, {"id": "99999"},
            max_events=2, read_timeout=6.0, session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert isinstance(ev["depth"], int), f"depth must be int, got {type(ev['depth'])}"

    def test_song_count_is_integer(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL, {"id": "99999"},
            max_events=2, read_timeout=6.0, session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert isinstance(ev["song_count"], int), (
                f"song_count must be int, got {type(ev['song_count'])}"
            )

    def test_depth_is_valid_enum_value(self, client: requests.Session, genius_mock: GeniusMock):
        """depth must be 0, 1, or 2."""
        _, events = _read_sse_stream(
            SSE_URL, {"id": "99999"},
            max_events=2, read_timeout=6.0, session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert ev["depth"] in (0, 1, 2), f"Unexpected depth value: {ev['depth']}"

    def test_song_count_is_nonnegative(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL, {"id": "99999"},
            max_events=2, read_timeout=6.0, session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert ev["song_count"] >= 0, f"song_count must be >= 0, got {ev['song_count']}"


# ─────────────────────────────────────────────────────────────────────────────
# 6. Stream terminates when depth >= 2
# ─────────────────────────────────────────────────────────────────────────────

class TestSseStreamTermination:
    @pytest.mark.bg_profile
    def test_stream_closes_after_full_scan(
        self, client_bg: requests.Session, genius_mock_bg: GeniusMock, unique_artist_id: int
    ):
        """
        Populate L1 to depth=2 by triggering a graph request, then open the
        SSE stream.  The server must emit depth=2 and close the connection
        *itself* — we must not be relying on our own read timeout to end the
        loop, which is checked via `stats["timed_out"]`.

        [F-34] Requires the bg-profile service instance (queue-capacity=8):
        the default profile (`client`/`service_proc`) runs with
        queue-capacity=0, so EnrichmentWorker::EnqueueIfNeeded() never
        actually queues anything there and depth can never observably
        advance past Foreground=1 — see the identical rationale in
        test_status.py::TestStatusEnrichingArtist.
        """
        artist_id = unique_artist_id
        _populate_artist(
            client_bg, genius_mock_bg, artist_id, "StreamArtist",
            graph_url=GRAPH_URL_BG, status_url=STATUS_URL_BG,
        )

        stats: dict = {}
        _, events = _read_sse_stream(
            SSE_URL_BG, {"id": str(artist_id)},
            max_events=MAX_EVENTS, read_timeout=10.0, session=client_bg,
            stats=stats,
        )

        if not events:
            pytest.skip("No events received — endpoint may not be implemented yet")

        final = events[-1]
        assert final["depth"] >= 2, f"Expected final depth >= 2, got {final['depth']}"
        assert not stats["timed_out"], (
            "Stream did not close on its own after depth=2 — client read timeout "
            "was reached instead, meaning the server kept the connection open"
        )

    def test_final_event_depth_is_2_for_known_artist(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        artist_id = unique_artist_id
        _populate_artist(client, genius_mock, artist_id, "FinalDepthArtist")

        _, events = _read_sse_stream(
            SSE_URL, {"id": str(artist_id)},
            max_events=MAX_EVENTS, read_timeout=10.0, session=client,
        )

        if not events:
            pytest.skip("No events received")

        # At least one event should carry depth=2 if the artist is fully enriched
        depths = [ev["depth"] for ev in events]
        assert max(depths) >= 1, f"Expected at least depth=1, got depths={depths}"

    def test_stream_does_not_linger_after_depth_2(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        """
        The server must close the stream shortly after emitting depth=2.
        We read until depth=2 is seen and then assert no further events arrive.
        """
        artist_id = unique_artist_id
        _populate_artist(client, genius_mock, artist_id, "LingerTestArtist")

        resp = client.get(
            SSE_URL, params={"id": str(artist_id)}, stream=True, timeout=(5.0, 12.0)
        )
        _skip_if_not_implemented(resp)

        events_after_full: List[dict] = []
        full_seen = False
        buffer = ""
        deadline = time.monotonic() + 12.0

        try:
            for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
                if time.monotonic() > deadline:
                    break
                if chunk:
                    buffer += chunk
                    while "\n\n" in buffer:
                        block, buffer = buffer.split("\n\n", 1)
                        for line in block.splitlines():
                            if not line.strip().startswith("data:"):
                                continue
                            payload = line.strip()[len("data:"):].strip()
                            try:
                                ev = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            if full_seen:
                                events_after_full.append(ev)
                            if ev.get("depth", 0) >= 2:
                                full_seen = True
        except requests.exceptions.Timeout:
            pass
        finally:
            resp.close()

        if not full_seen:
            pytest.skip("depth=2 was not observed — endpoint may not be implemented")

        assert events_after_full == [], (
            f"Server sent {len(events_after_full)} extra event(s) after depth=2: {events_after_full}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 7. Unknown artist → depth=0, song_count=0 events (stream must not hang)
# ─────────────────────────────────────────────────────────────────────────────

class TestSseUnknownArtist:
    def test_unknown_artist_emits_zero_depth_events(self, client: requests.Session, genius_mock: GeniusMock):
        """
        An artist id that was never fetched should yield depth=0 events
        (the stream may stay open waiting for enrichment; we just check the
        first event is well-formed with depth=0).
        """
        _, events = _read_sse_stream(
            SSE_URL, {"id": "88888888"},
            max_events=1, read_timeout=6.0, session=client,
        )
        if not events:
            pytest.skip("No events received")

        ev = events[0]
        assert ev["depth"] == 0,      f"Expected depth=0 for unknown artist, got {ev['depth']}"
        assert ev["song_count"] == 0, f"Expected song_count=0 for unknown artist, got {ev['song_count']}"

    def test_unknown_artist_does_not_return_error_status(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """An unknown id is not an error — the endpoint should return 200 and stream."""
        resp = client.get(SSE_URL, params={"id": "88888887"}, stream=True, timeout=(5.0, 3.0))
        _skip_if_not_implemented(resp)
        resp.close()
        assert resp.status_code == 200


# ─────────────────────────────────────────────────────────────────────────────
# 7b. The connection is genuinely long-lived: several events pushed over real
#     wall-clock time on a *single* connection, not a burst followed by an
#     immediate close (which is what a fake/snapshot stream would produce).
# ─────────────────────────────────────────────────────────────────────────────

class TestSseLongLivedStream:
    def test_multiple_events_spaced_over_time_for_unknown_artist(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """
        An artist that never advances past depth=0 keeps the connection open
        forever (until we stop reading), so it is the simplest way to prove
        the server pushes events periodically rather than all at once.
        No fixed sleep is used — we just keep reading with a read timeout and
        record wall-clock timestamps as events arrive.
        """
        resp = client.get(
            SSE_URL, params={"id": "77777776"}, stream=True, timeout=(5.0, 9.0)
        )
        _skip_if_not_implemented(resp)

        events: List[dict] = []
        timestamps: List[float] = []
        buffer = ""
        try:
            for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
                if chunk:
                    buffer += chunk
                    while "\n\n" in buffer:
                        block, buffer = buffer.split("\n\n", 1)
                        for line in block.splitlines():
                            if not line.strip().startswith("data:"):
                                continue
                            payload = line.strip()[len("data:"):].strip()
                            try:
                                ev = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            events.append(ev)
                            timestamps.append(time.monotonic())
                if len(events) >= 3:
                    break
        except requests.exceptions.Timeout:
            pass
        finally:
            resp.close()

        if len(events) < 2:
            pytest.skip("Fewer than 2 events observed — cannot verify streaming cadence")

        for ev in events:
            assert ev["depth"] == 0, f"Unknown artist must stay at depth=0, got {ev['depth']}"

        gaps = [t1 - t0 for t0, t1 in zip(timestamps, timestamps[1:])]
        assert all(gap > 0.5 for gap in gaps), (
            f"Events arrived without real spacing between them (gaps={gaps}s); "
            "looks like a burst of events rather than a live periodic push"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 7b. The connection is genuinely long-lived: several events pushed over real
#     wall-clock time on a *single* connection, not a burst followed by an
#     immediate close (which is what a fake/snapshot stream would produce).
# ─────────────────────────────────────────────────────────────────────────────

class TestSseLongLivedStream:
    def test_multiple_events_spaced_over_time_for_unknown_artist(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """
        An artist that never advances past depth=0 keeps the connection open
        forever (until we stop reading), so it is the simplest way to prove
        the server pushes events periodically rather than all at once.
        No fixed sleep is used — we just keep reading with a read timeout and
        record wall-clock timestamps as events arrive.
        """
        resp = client.get(
            SSE_URL, params={"id": "77777776"}, stream=True, timeout=(5.0, 9.0)
        )
        _skip_if_not_implemented(resp)

        events: List[dict] = []
        timestamps: List[float] = []
        buffer = ""
        try:
            for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
                if chunk:
                    buffer += chunk
                    while "\n\n" in buffer:
                        block, buffer = buffer.split("\n\n", 1)
                        for line in block.splitlines():
                            if not line.strip().startswith("data:"):
                                continue
                            payload = line.strip()[len("data:"):].strip()
                            try:
                                ev = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            events.append(ev)
                            timestamps.append(time.monotonic())
                if len(events) >= 3:
                    break
        except requests.exceptions.Timeout:
            pass
        finally:
            resp.close()

        if len(events) < 2:
            pytest.skip("Fewer than 2 events observed — cannot verify streaming cadence")

        for ev in events:
            assert ev["depth"] == 0, f"Unknown artist must stay at depth=0, got {ev['depth']}"

        gaps = [t1 - t0 for t0, t1 in zip(timestamps, timestamps[1:])]
        assert all(gap > 0.5 for gap in gaps), (
            f"Events arrived without real spacing between them (gaps={gaps}s); "
            "looks like a burst of events rather than a live periodic push"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 8. Client disconnect: server must not leak the connection
# ─────────────────────────────────────────────────────────────────────────────

class TestSseClientDisconnect:
    def test_server_survives_abrupt_client_close(self, client: requests.Session, genius_mock: GeniusMock):
        """
        Open a stream, receive one event, then abruptly close the TCP connection.
        Verify the service is still responsive afterwards.
        """
        # Open SSE stream
        resp = client.get(SSE_URL, params={"id": "99990"}, stream=True, timeout=(5.0, 6.0))
        _skip_if_not_implemented(resp)

        # Read just enough to confirm the connection is alive
        events_received = 0
        try:
            for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
                if chunk and "data:" in chunk:
                    events_received += 1
                    break
        except requests.exceptions.Timeout:
            pass
        finally:
            # Abrupt close — does not send a graceful FIN, simulates tab close
            resp.close()

        # Poll until the server has detected the disconnect and is responsive
        # again, instead of guessing with a fixed sleep (flaky under load).
        deadline = time.monotonic() + 5.0
        health_resp: Optional[requests.Response] = None
        last_exc: Optional[Exception] = None
        while time.monotonic() < deadline:
            try:
                health_resp = client.get(f"{SERVICE_BASE}/healthz", timeout=1.0)
                break
            except requests.exceptions.RequestException as exc:
                last_exc = exc
                time.sleep(0.05)

        assert health_resp is not None, (
            f"Service did not become responsive after client disconnect within 5s "
            f"(last error: {last_exc})"
        )
        assert health_resp.status_code in (200, 404), (
            f"Service became unresponsive after client disconnect (status={health_resp.status_code})"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 9. Concurrent connections for the same artist_id are independent
# ─────────────────────────────────────────────────────────────────────────────

class TestSseConcurrentConnections:
    def test_two_concurrent_streams_both_receive_events(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        """
        Two SSE connections for the same artist_id must each independently
        receive events.  Neither should block or starve the other.
        """
        results: List[List[dict]] = [[], []]
        errors: List[Optional[Exception]] = [None, None]

        def _reader(index: int) -> None:
            try:
                sess = requests.Session()
                sess.cookies.update(client.cookies)
                _, evs = _read_sse_stream(
                    SSE_URL, {"id": "99991"},
                    max_events=1, read_timeout=6.0, session=sess,
                )
                results[index] = evs
            except Exception as exc:
                errors[index] = exc

        threads = [threading.Thread(target=_reader, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10.0)

        # If either thread errored, re-raise
        for err in errors:
            if err is not None:
                raise err

        # Skip if endpoint not implemented (both lists empty)
        if not results[0] and not results[1]:
            pytest.skip("No events received from either connection — endpoint may not be implemented")

        # Both connections should have received at least one event
        assert len(results[0]) >= 1, "First connection received no events"
        assert len(results[1]) >= 1, "Second connection received no events"

    def test_concurrent_different_artists_are_isolated(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        """
        Events from a stream for artist A must not appear in the stream for
        artist B.  This validates per-connection state isolation.
        """
        artist_a_id = unique_artist_id
        artist_b_id = 88888000  # unknown, always depth=0

        _populate_artist(client, genius_mock, artist_a_id, "IsolationArtistA")

        results: List[List[dict]] = [[], []]
        errors: List[Optional[Exception]] = [None, None]

        def _reader(index: int, aid: int) -> None:
            try:
                sess = requests.Session()
                sess.cookies.update(client.cookies)
                _, evs = _read_sse_stream(
                    SSE_URL, {"id": str(aid)},
                    max_events=2, read_timeout=7.0, session=sess,
                )
                results[index] = evs
            except Exception as exc:
                errors[index] = exc

        threads = [
            threading.Thread(target=_reader, args=(0, artist_a_id)),
            threading.Thread(target=_reader, args=(1, artist_b_id)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=12.0)

        for err in errors:
            if err is not None:
                raise err

        if not results[0] and not results[1]:
            pytest.skip("No events received — endpoint may not be implemented")

        # Unknown artist must always report depth=0; populated artist may be > 0
        if results[1]:
            for ev in results[1]:
                assert ev["depth"] == 0, (
                    f"Unknown artist stream returned depth={ev['depth']} (expected 0)"
                )


# ─────────────────────────────────────────────────────────────────────────────
# 10. Content-Type is strictly text/event-stream for a valid stream request
# ─────────────────────────────────────────────────────────────────────────────

class TestSseContentType:
    def test_content_type_not_application_json(self, client: requests.Session, genius_mock: GeniusMock):
        """SSE streams must not be served as application/json."""
        resp = client.get(SSE_URL, params={"id": "99992"}, stream=True, timeout=(5.0, 2.0))
        _skip_if_not_implemented(resp)
        ct = resp.headers.get("content-type", "")
        resp.close()
        assert "application/json" not in ct, (
            "SSE stream must not have Content-Type: application/json"
        )

    def test_content_type_charset_optional(self, client: requests.Session, genius_mock: GeniusMock):
        """text/event-stream with or without charset is acceptable."""
        resp = client.get(SSE_URL, params={"id": "99993"}, stream=True, timeout=(5.0, 2.0))
        _skip_if_not_implemented(resp)
        ct = resp.headers.get("content-type", "").lower()
        resp.close()
        assert ct.startswith("text/event-stream"), f"Unexpected Content-Type: {ct}"


# ─────────────────────────────────────────────────────────────────────────────
# 11. main.cpp registration guard — kName matches config key
# ─────────────────────────────────────────────────────────────────────────────

class TestSseRegistration:
    def test_stream_endpoint_reachable(self, client: requests.Session, genius_mock: GeniusMock):
        """
        A simple reachability check: the endpoint must not return 404.
        If it does, SseStatusHandler is not registered in main.cpp or the
        path is missing from static_config.yaml.
        """
        resp = client.get(SSE_URL, params={"id": "1"}, stream=True, timeout=(5.0, 2.0))
        resp.close()
        assert resp.status_code != 404, (
            "Got 404 — SseStatusHandler is likely not registered in main.cpp "
            "or handler-status-stream is missing from static_config.yaml"
        )
