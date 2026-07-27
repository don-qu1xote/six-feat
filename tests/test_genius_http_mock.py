"""
test_genius_http_mock.py — unit tests for conftest.py's GeniusMock / _MockState
===================================================================================

GeniusMock is the surrogate Genius API used by every integration test in
test_graph.py / test_path.py / test_rate_limit.py. A regression here is
invisible in any individual test's own logic — it manifests as confusing
502/genius_error failures several layers downstream in the real service,
which is exactly what happened: see TestMultipleResolveCallsDoNotClobber
below for the bug this pins down.

These are pure-Python tests against conftest.py's own helper classes —
no compiled binary, no running service needed.
"""

from __future__ import annotations

import pytest

from conftest import GeniusMock, _MockState


def _dispatch_search(state: _MockState, query: str):
    return state.dispatch("/search", {"q": [query]})


class TestMultipleResolveCallsDoNotClobber:
    """
    Regression test for a real bug: GeniusMock.resolve() used to register a
    fresh closure directly on _MockState's "/search" path prefix on every
    call. _MockState.register() does a plain dict assignment (last write
    wins, no merging), so calling resolve() twice for two different artist
    names — the standard from/to path-test pattern — silently discarded the
    first registration. Any test that then queried the first artist's name
    got an unregistered-path 404 from _MockState.dispatch()'s fallback,
    which the real service's GeniusGateway::GeniusGet() turns into a
    GeniusHttpError that propagates as an unrelated-looking 502
    "genius_error" response several call-frames away from the actual cause.

    Fixed by accumulating query->response into a single shared dict with
    one persistent "/search" handler (see GeniusMock._search_responses /
    _register_search_handler in conftest.py).
    """

    def test_two_distinct_queries_both_resolve(self):
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve("ArtistA", [{"id": 100, "name": "ArtistA", "score": 0.98}])
        mock.resolve("ArtistB", [{"id": 101, "name": "ArtistB", "score": 0.98}])

        status_a, body_a = _dispatch_search(state, "ArtistA")
        status_b, body_b = _dispatch_search(state, "ArtistB")

        assert status_a == 200
        assert status_b == 200
        assert body_a["response"]["hits"][0]["result"]["primary_artist"]["id"] == 100
        assert body_b["response"]["hits"][0]["result"]["primary_artist"]["id"] == 101

    def test_first_query_not_lost_after_second_registration(self):
        """Direct regression check: register A, then B, then re-verify A
        still resolves — this is the exact failure mode that previously
        turned into a 502 in TestDirectPath/TestTwoHopPath/etc."""
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve("First", [{"id": 1, "name": "First", "score": 0.9}])
        mock.resolve("Second", [{"id": 2, "name": "Second", "score": 0.9}])

        status, body = _dispatch_search(state, "First")
        assert status == 200, "First registration must survive a later resolve() call"
        assert body["response"]["hits"][0]["result"]["primary_artist"]["id"] == 1

    def test_three_or_more_queries_all_coexist(self):
        state = _MockState()
        mock = GeniusMock(state)
        names = ["Alpha", "Beta", "Gamma", "Delta"]
        for i, name in enumerate(names):
            mock.resolve(name, [{"id": i, "name": name, "score": 0.9}])

        for i, name in enumerate(names):
            status, body = _dispatch_search(state, name)
            assert status == 200, f"{name} should still resolve"
            assert body["response"]["hits"][0]["result"]["primary_artist"]["id"] == i

    def test_resolve_empty_coexists_with_other_resolves(self):
        """Mirrors TestUnknownArtist in test_path.py: resolve_empty() for a
        'ghost' artist registered alongside a real resolve() for a known
        artist — both must independently work."""
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve_empty("GhostArtist")
        mock.resolve("RealArtist", [{"id": 500, "name": "RealArtist", "score": 0.99}])

        ghost_status, ghost_body = _dispatch_search(state, "GhostArtist")
        real_status, real_body = _dispatch_search(state, "RealArtist")

        assert ghost_status == 200
        assert ghost_body["response"]["hits"] == []
        assert real_status == 200
        assert len(real_body["response"]["hits"]) == 1

    def test_resolve_called_in_either_order(self):
        """resolve_empty() before resolve(), and vice versa, must both work
        — order of registration must not matter."""
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve("RealArtist", [{"id": 500, "name": "RealArtist", "score": 0.99}])
        mock.resolve_empty("GhostArtist2")

        ghost_status, _ = _dispatch_search(state, "GhostArtist2")
        real_status, _ = _dispatch_search(state, "RealArtist")
        assert ghost_status == 200
        assert real_status == 200


class TestResolveBasics:
    def test_unregistered_query_returns_404(self):
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve("Known", [{"id": 1, "name": "Known", "score": 0.9}])

        status, body = _dispatch_search(state, "NeverRegistered")
        assert status == 404
        assert body["response"]["hits"] == []

    def test_re_resolving_same_query_overwrites_that_querys_response_only(self):
        """Calling resolve() twice for the SAME query name is a legitimate
        way to change its programmed response mid-test; it must not affect
        any other already-registered query."""
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.9}])
        mock.resolve("Other", [{"id": 9, "name": "Other", "score": 0.9}])
        mock.resolve("Drake", [{"id": 2, "name": "Drake (updated)", "score": 0.95}])

        status, body = _dispatch_search(state, "Drake")
        assert body["response"]["hits"][0]["result"]["primary_artist"]["id"] == 2

        other_status, other_body = _dispatch_search(state, "Other")
        assert other_status == 200
        assert other_body["response"]["hits"][0]["result"]["primary_artist"]["id"] == 9

    def test_candidate_fields_mapped_correctly(self):
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve(
            "Drake",
            [{"id": 1, "name": "Drake", "image": "img.png", "url": "http://x"}],
        )
        _, body = _dispatch_search(state, "Drake")
        artist = body["response"]["hits"][0]["result"]["primary_artist"]
        assert artist == {"id": 1, "name": "Drake", "image_url": "img.png", "url": "http://x"}

    def test_multiple_candidates_for_one_query_all_present(self):
        """Ambiguous-name scenario (e.g. test_graph.py's TestGraphAmbiguous):
        a single query can map to multiple candidate hits."""
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve(
            "Chris",
            [
                {"id": 10, "name": "Chris Brown", "score": 0.60},
                {"id": 11, "name": "Chris Martin", "score": 0.58},
            ],
        )
        _, body = _dispatch_search(state, "Chris")
        hits = body["response"]["hits"]
        assert len(hits) == 2
        ids = {h["result"]["primary_artist"]["id"] for h in hits}
        assert ids == {10, 11}


class TestSearchError:
    def test_search_error_overrides_all_queries(self):
        """Unlike resolve(), search_error() is a deliberate blanket failure
        for every /search query — it intentionally replaces the whole
        handler rather than merging, which this test documents."""
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve("Known", [{"id": 1, "name": "Known", "score": 0.9}])
        mock.search_error(503)

        status, body = _dispatch_search(state, "Known")
        assert status == 503
        assert "error" in body

    def test_search_error_default_status_is_503(self):
        state = _MockState()
        mock = GeniusMock(state)
        mock.search_error()
        status, _ = _dispatch_search(state, "anything")
        assert status == 503

    def test_search_error_custom_status(self):
        state = _MockState()
        mock = GeniusMock(state)
        mock.search_error(429)
        status, _ = _dispatch_search(state, "anything")
        assert status == 429


class TestSharedStateAcrossInstances:
    def test_second_instance_registration_does_not_see_first_instances_queries(self):
        """Known limitation, not a guarantee: each GeniusMock instance owns
        its own private _search_responses dict. Two separate instances
        operating on the same _MockState do NOT merge their query sets —
        the second instance's _register_search_handler() call replaces the
        shared "/search" handler with one that only knows about its own
        queries, so the first instance's earlier registration becomes
        unreachable (back to a 404).

        This is safe in the real test suite because the `genius_mock`
        pytest fixture is function-scoped and hands out exactly one fresh
        GeniusMock instance per test — every test in test_graph.py /
        test_path.py calls .resolve() multiple times on that SAME instance,
        which is the scenario TestMultipleResolveCallsDoNotClobber verifies
        works correctly. This test exists only to make the boundary of that
        guarantee explicit, so nobody accidentally relies on two separate
        GeniusMock() instances composing."""
        state = _MockState()
        mock1 = GeniusMock(state)
        mock1.resolve("First", [{"id": 1, "name": "First", "score": 0.9}])

        mock2 = GeniusMock(state)
        mock2.resolve("Second", [{"id": 2, "name": "Second", "score": 0.9}])

        first_status, _ = _dispatch_search(state, "First")
        assert first_status == 404

        second_status, second_body = _dispatch_search(state, "Second")
        assert second_status == 200
        assert second_body["response"]["hits"][0]["result"]["primary_artist"]["id"] == 2

    def test_reset_clears_all_registrations(self):
        state = _MockState()
        mock = GeniusMock(state)
        mock.resolve("Drake", [{"id": 1, "name": "Drake", "score": 0.9}])
        status, _ = _dispatch_search(state, "Drake")
        assert status == 200

        state.reset()

        status_after, body_after = _dispatch_search(state, "Drake")
        assert status_after == 404
        assert body_after == {"error": {"message": "Not found"}}
