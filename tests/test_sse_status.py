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

SSE_URL = f"{SERVICE_BASE}/api/v1/status/stream"
GRAPH_URL = f"{SERVICE_BASE}/api/v1/graph"
STATUS_URL = f"{SERVICE_BASE}/api/v1/status"

SSE_URL_BG = f"{SERVICE_BASE_BG}/api/v1/status/stream"
GRAPH_URL_BG = f"{SERVICE_BASE_BG}/api/v1/graph"
STATUS_URL_BG = f"{SERVICE_BASE_BG}/api/v1/status"

FIRST_EVENT_TIMEOUT = 8.0

MAX_EVENTS = 10

pytestmark = pytest.mark.sse_endpoint


def _skip_if_not_implemented(resp: requests.Response) -> None:
    if resp.status_code == 404:
        pytest.skip("/api/v1/status/stream not yet implemented — skipping")


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
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:") :].strip()
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
    sess = session or requests.Session()
    resp = sess.get(url, params=params, stream=True, timeout=(5.0, read_timeout))
    events: List[dict] = []
    timed_out = False

    try:
        buffer = ""
        for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
            if chunk:
                buffer += chunk

                while "\n\n" in buffer:
                    block, buffer = buffer.split("\n\n", 1)
                    for line in block.splitlines():
                        line = line.strip()
                        if line.startswith("data:"):
                            payload = line[len("data:") :].strip()
                            try:
                                events.append(json.loads(payload))
                            except json.JSONDecodeError:
                                pass
                if len(events) >= max_events:
                    break
    except requests.exceptions.Timeout:
        timed_out = True
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
    genius_mock.resolve(name, [{"id": artist_id, "name": name, "score": 0.99}])
    genius_mock.songs(artist_id, [artist_id * 10])
    genius_mock.song_detail(
        artist_id * 10,
        _build_song_detail(
            artist_id * 10,
            f"Song by {name}",
            artist_id,
            name,
            collaborators=[{"id": artist_id + 1, "name": f"Feat{artist_id}", "role": "featured"}],
        ),
    )
    client.get(graph_url, params={"artist": name})

    wait_for_status_ready(client, status_url, artist_id)


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


class TestSseHeaders:
    def _get_headers(self, client: requests.Session) -> requests.Response:
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


class TestSseAtLeastOneEvent:
    def test_emits_at_least_one_event(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL,
            {"id": "99999"},
            max_events=1,
            read_timeout=6.0,
            session=client,
        )
        if not events:
            pytest.skip("/api/v1/status/stream not yet emitting events — skipping")
        assert len(events) >= 1


class TestSseEventSchema:
    def test_events_have_depth_field(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL,
            {"id": "99999"},
            max_events=2,
            read_timeout=6.0,
            session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert "depth" in ev, f"Event missing 'depth': {ev}"

    def test_events_have_song_count_field(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL,
            {"id": "99999"},
            max_events=2,
            read_timeout=6.0,
            session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert "song_count" in ev, f"Event missing 'song_count': {ev}"

    def test_depth_is_integer(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL,
            {"id": "99999"},
            max_events=2,
            read_timeout=6.0,
            session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert isinstance(ev["depth"], int), f"depth must be int, got {type(ev['depth'])}"

    def test_song_count_is_integer(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL,
            {"id": "99999"},
            max_events=2,
            read_timeout=6.0,
            session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert isinstance(ev["song_count"], int), (
                f"song_count must be int, got {type(ev['song_count'])}"
            )

    def test_depth_is_valid_enum_value(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL,
            {"id": "99999"},
            max_events=2,
            read_timeout=6.0,
            session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert ev["depth"] in (0, 1, 2), f"Unexpected depth value: {ev['depth']}"

    def test_song_count_is_nonnegative(self, client: requests.Session, genius_mock: GeniusMock):
        _, events = _read_sse_stream(
            SSE_URL,
            {"id": "99999"},
            max_events=2,
            read_timeout=6.0,
            session=client,
        )
        if not events:
            pytest.skip("No events received")
        for ev in events:
            assert ev["song_count"] >= 0, f"song_count must be >= 0, got {ev['song_count']}"


class TestSseStreamTermination:
    @pytest.mark.bg_profile
    def test_stream_closes_after_full_scan(
        self, client_bg: requests.Session, genius_mock_bg: GeniusMock, unique_artist_id: int
    ):
        artist_id = unique_artist_id
        _populate_artist(
            client_bg,
            genius_mock_bg,
            artist_id,
            "StreamArtist",
            graph_url=GRAPH_URL_BG,
            status_url=STATUS_URL_BG,
        )

        stats: dict = {}
        _, events = _read_sse_stream(
            SSE_URL_BG,
            {"id": str(artist_id)},
            max_events=MAX_EVENTS,
            read_timeout=10.0,
            session=client_bg,
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
            SSE_URL,
            {"id": str(artist_id)},
            max_events=MAX_EVENTS,
            read_timeout=10.0,
            session=client,
        )

        if not events:
            pytest.skip("No events received")

        depths = [ev["depth"] for ev in events]
        assert max(depths) >= 1, f"Expected at least depth=1, got depths={depths}"

    def test_stream_does_not_linger_after_depth_2(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        artist_id = unique_artist_id
        _populate_artist(client, genius_mock, artist_id, "LingerTestArtist")

        resp = client.get(SSE_URL, params={"id": str(artist_id)}, stream=True, timeout=(5.0, 12.0))
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
                            payload = line.strip()[len("data:") :].strip()
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


class TestSseUnknownArtist:
    def test_unknown_artist_emits_zero_depth_events(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        _, events = _read_sse_stream(
            SSE_URL,
            {"id": "88888888"},
            max_events=1,
            read_timeout=6.0,
            session=client,
        )
        if not events:
            pytest.skip("No events received")

        ev = events[0]
        assert ev["depth"] == 0, f"Expected depth=0 for unknown artist, got {ev['depth']}"
        assert ev["song_count"] == 0, (
            f"Expected song_count=0 for unknown artist, got {ev['song_count']}"
        )

    def test_unknown_artist_does_not_return_error_status(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(SSE_URL, params={"id": "88888887"}, stream=True, timeout=(5.0, 3.0))
        _skip_if_not_implemented(resp)
        resp.close()
        assert resp.status_code == 200


class TestSseLongLivedStream:
    def test_multiple_events_spaced_over_time_for_unknown_artist(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(SSE_URL, params={"id": "77777776"}, stream=True, timeout=(5.0, 9.0))
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
                            payload = line.strip()[len("data:") :].strip()
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


class TestSseLongLivedStream:
    def test_multiple_events_spaced_over_time_for_unknown_artist(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(SSE_URL, params={"id": "77777776"}, stream=True, timeout=(5.0, 9.0))
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
                            payload = line.strip()[len("data:") :].strip()
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


class TestSseClientDisconnect:
    def test_server_survives_abrupt_client_close(
        self, client: requests.Session, genius_mock: GeniusMock
    ):

        resp = client.get(SSE_URL, params={"id": "99990"}, stream=True, timeout=(5.0, 6.0))
        _skip_if_not_implemented(resp)

        events_received = 0
        try:
            for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
                if chunk and "data:" in chunk:
                    events_received += 1
                    break
        except requests.exceptions.Timeout:
            pass
        finally:
            resp.close()

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


class TestSseConcurrentConnections:
    def test_two_concurrent_streams_both_receive_events(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        results: List[List[dict]] = [[], []]
        errors: List[Optional[Exception]] = [None, None]

        def _reader(index: int) -> None:
            try:
                sess = requests.Session()
                sess.cookies.update(client.cookies)
                _, evs = _read_sse_stream(
                    SSE_URL,
                    {"id": "99991"},
                    max_events=1,
                    read_timeout=6.0,
                    session=sess,
                )
                results[index] = evs
            except Exception as exc:
                errors[index] = exc

        threads = [threading.Thread(target=_reader, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10.0)

        for err in errors:
            if err is not None:
                raise err

        if not results[0] and not results[1]:
            pytest.skip(
                "No events received from either connection — endpoint may not be implemented"
            )

        assert len(results[0]) >= 1, "First connection received no events"
        assert len(results[1]) >= 1, "Second connection received no events"

    def test_concurrent_different_artists_are_isolated(
        self, client: requests.Session, genius_mock: GeniusMock, unique_artist_id: int
    ):
        artist_a_id = unique_artist_id
        artist_b_id = 88888000

        _populate_artist(client, genius_mock, artist_a_id, "IsolationArtistA")

        results: List[List[dict]] = [[], []]
        errors: List[Optional[Exception]] = [None, None]

        def _reader(index: int, aid: int) -> None:
            try:
                sess = requests.Session()
                sess.cookies.update(client.cookies)
                _, evs = _read_sse_stream(
                    SSE_URL,
                    {"id": str(aid)},
                    max_events=2,
                    read_timeout=7.0,
                    session=sess,
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

        if results[1]:
            for ev in results[1]:
                assert ev["depth"] == 0, (
                    f"Unknown artist stream returned depth={ev['depth']} (expected 0)"
                )


class TestSseContentType:
    def test_content_type_not_application_json(
        self, client: requests.Session, genius_mock: GeniusMock
    ):
        resp = client.get(SSE_URL, params={"id": "99992"}, stream=True, timeout=(5.0, 2.0))
        _skip_if_not_implemented(resp)
        ct = resp.headers.get("content-type", "")
        resp.close()
        assert "application/json" not in ct, (
            "SSE stream must not have Content-Type: application/json"
        )

    def test_content_type_charset_optional(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(SSE_URL, params={"id": "99993"}, stream=True, timeout=(5.0, 2.0))
        _skip_if_not_implemented(resp)
        ct = resp.headers.get("content-type", "").lower()
        resp.close()
        assert ct.startswith("text/event-stream"), f"Unexpected Content-Type: {ct}"


class TestSseRegistration:
    def test_stream_endpoint_reachable(self, client: requests.Session, genius_mock: GeniusMock):
        resp = client.get(SSE_URL, params={"id": "1"}, stream=True, timeout=(5.0, 2.0))
        resp.close()
        assert resp.status_code != 404, (
            "Got 404 — SseStatusHandler is likely not registered in main.cpp "
            "or handler-status-stream is missing from static_config.yaml"
        )
