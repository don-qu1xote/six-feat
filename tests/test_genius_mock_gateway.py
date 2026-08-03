from __future__ import annotations

import pytest

from mocks.mock_genius_gateway import (
    ArtistRef,
    Candidate,
    GeniusHttpError,
    MockGeniusGateway,
    SongRecord,
    TrackCredit,
    make_artist,
    make_song,
)


class TestResolveCandidates:
    def test_programmed_response_returned(self):
        mock = MockGeniusGateway()
        candidates = [Candidate(id=1, name="Drake", score=0.99)]
        mock.set_resolve_response("Drake", candidates)
        assert mock.ResolveCandidates("Drake") == candidates

    def test_unprogrammed_query_returns_empty_list(self):
        mock = MockGeniusGateway()
        assert mock.ResolveCandidates("never configured") == []

    def test_error_is_raised(self):
        mock = MockGeniusGateway()
        mock.set_resolve_error(503, query="Drake")
        with pytest.raises(GeniusHttpError) as exc_info:
            mock.ResolveCandidates("Drake")
        assert exc_info.value.status_code == 503

    def test_side_effect_callable_invoked_with_query(self):
        mock = MockGeniusGateway()
        seen = []

        def side_effect(query):
            seen.append(query)
            return [Candidate(id=2, name=query)]

        mock.set_resolve_side_effect("Anyone", side_effect)
        result = mock.ResolveCandidates("Anyone")
        assert seen == ["Anyone"]
        assert result[0].name == "Anyone"

    def test_wildcard_fallback_used_for_unmatched_query(self):
        mock = MockGeniusGateway()
        wildcard = [Candidate(id=99, name="Wildcard")]
        mock.set_resolve_response("*", wildcard)
        assert mock.ResolveCandidates("anything") == wildcard

    def test_specific_query_takes_priority_over_wildcard(self):
        mock = MockGeniusGateway()
        mock.set_resolve_response("*", [Candidate(id=99, name="Wildcard")])
        mock.set_resolve_response("Drake", [Candidate(id=1, name="Drake")])
        result = mock.ResolveCandidates("Drake")
        assert len(result) == 1
        assert result[0].name == "Drake"

    def test_empty_list_response_does_not_fall_through_to_wildcard_error(self):
        mock = MockGeniusGateway()
        mock.set_resolve_response("KnownButEmpty", [])
        mock.set_resolve_error(503, query="*")
        assert mock.ResolveCandidates("KnownButEmpty") == []

    def test_empty_list_response_without_wildcard_also_returns_empty(self):
        mock = MockGeniusGateway()
        mock.set_resolve_response("KnownButEmpty", [])
        assert mock.ResolveCandidates("KnownButEmpty") == []

    def test_call_is_recorded(self):
        mock = MockGeniusGateway()
        mock.set_resolve_response("Drake", [])
        mock.ResolveCandidates("Drake")
        assert mock.call_count("ResolveCandidates") == 1
        assert mock.calls[0]["query"] == "Drake"


class TestFetchArtistById:
    def test_programmed_response_returned(self):
        mock = MockGeniusGateway()
        ref = ArtistRef(id=1, name="Drake")
        mock.set_artist_response(1, ref)
        assert mock.FetchArtistById(1) == ref

    def test_explicit_none_response_returns_none(self):
        mock = MockGeniusGateway()
        mock.set_artist_response(404, None)
        assert mock.FetchArtistById(404) is None

    def test_unprogrammed_id_returns_none(self):
        mock = MockGeniusGateway()
        assert mock.FetchArtistById(12345) is None

    def test_error_is_raised(self):
        mock = MockGeniusGateway()
        mock.set_artist_error(1, 401)
        with pytest.raises(GeniusHttpError) as exc_info:
            mock.FetchArtistById(1)
        assert exc_info.value.status_code == 401

    def test_default_lane_is_recorded(self):
        mock = MockGeniusGateway()
        mock.set_artist_response(1, ArtistRef(id=1, name="X"))
        mock.FetchArtistById(1)
        assert mock.calls[0]["lane"] == "Foreground"

    def test_explicit_lane_is_recorded(self):
        mock = MockGeniusGateway()
        mock.set_artist_response(1, ArtistRef(id=1, name="X"))
        mock.FetchArtistById(1, lane="Background")
        assert mock.calls[0]["lane"] == "Background"


class TestFetchSongList:
    def test_programmed_response_returned(self):
        mock = MockGeniusGateway()
        mock.set_song_list_response(1, [101, 102, 103])
        assert mock.FetchSongList(1, limit=10, lane="Foreground") == [101, 102, 103]

    def test_limit_truncates_results(self):
        mock = MockGeniusGateway()
        mock.set_song_list_response(1, [101, 102, 103, 104, 105])
        assert mock.FetchSongList(1, limit=2, lane="Foreground") == [101, 102]

    def test_unprogrammed_artist_returns_empty_list(self):
        mock = MockGeniusGateway()
        assert mock.FetchSongList(999, limit=10, lane="Foreground") == []

    def test_empty_song_list_is_a_valid_response(self):
        mock = MockGeniusGateway()
        mock.set_song_list_response(1, [])
        assert mock.FetchSongList(1, limit=10, lane="Foreground") == []

    def test_error_is_raised(self):
        mock = MockGeniusGateway()
        mock.set_song_list_error(1, 429)
        with pytest.raises(GeniusHttpError) as exc_info:
            mock.FetchSongList(1, limit=10, lane="Foreground")
        assert exc_info.value.status_code == 429

    def test_call_records_all_params(self):
        mock = MockGeniusGateway()
        mock.set_song_list_response(1, [101])
        mock.FetchSongList(1, limit=5, lane="Background")
        call = mock.calls[0]
        assert call == {
            "method": "FetchSongList",
            "artist_id": 1,
            "limit": 5,
            "lane": "Background",
        }


class TestFetchSongDetail:
    def test_programmed_response_returned(self):
        mock = MockGeniusGateway()
        record = SongRecord(id=101, title="God's Plan")
        mock.set_song_detail_response(101, record)
        assert mock.FetchSongDetail(101) == record

    def test_unprogrammed_song_returns_none(self):
        mock = MockGeniusGateway()
        assert mock.FetchSongDetail(999) is None

    def test_explicit_none_response_returns_none(self):
        mock = MockGeniusGateway()
        mock.set_song_detail_response(101, None)
        assert mock.FetchSongDetail(101) is None

    def test_error_is_raised(self):
        mock = MockGeniusGateway()
        mock.set_song_detail_error(101, 503)
        with pytest.raises(GeniusHttpError) as exc_info:
            mock.FetchSongDetail(101)
        assert exc_info.value.status_code == 503

    def test_slow_response_invokes_callable_form(self):
        mock = MockGeniusGateway()
        mock.set_song_detail_slow(101, delay_s=0.01)
        result = mock.FetchSongDetail(101)
        assert result is None


class TestCallTracking:
    def test_call_count_zero_when_never_called(self):
        mock = MockGeniusGateway()
        assert mock.call_count("ResolveCandidates") == 0

    def test_assert_called_passes_after_call(self):
        mock = MockGeniusGateway()
        mock.set_resolve_response("Drake", [])
        mock.ResolveCandidates("Drake")
        mock.assert_called("ResolveCandidates")

    def test_assert_called_raises_when_not_called(self):
        mock = MockGeniusGateway()
        with pytest.raises(AssertionError):
            mock.assert_called("ResolveCandidates")

    def test_assert_not_called_passes_when_untouched(self):
        mock = MockGeniusGateway()
        mock.assert_not_called("FetchArtistById")

    def test_assert_not_called_raises_after_call(self):
        mock = MockGeniusGateway()
        mock.set_artist_response(1, ArtistRef(id=1, name="X"))
        mock.FetchArtistById(1)
        with pytest.raises(AssertionError):
            mock.assert_not_called("FetchArtistById")

    def test_reset_clears_calls_and_programmed_responses(self):
        mock = MockGeniusGateway()
        mock.set_resolve_response("Drake", [Candidate(id=1, name="Drake")])
        mock.ResolveCandidates("Drake")
        assert mock.call_count("ResolveCandidates") == 1

        mock.reset()

        assert mock.call_count("ResolveCandidates") == 0
        assert mock.ResolveCandidates("Drake") == []

    def test_multiple_calls_to_same_method_all_recorded(self):
        mock = MockGeniusGateway()
        mock.set_resolve_response("A", [])
        mock.set_resolve_response("B", [])
        mock.ResolveCandidates("A")
        mock.ResolveCandidates("B")
        assert mock.call_count("ResolveCandidates") == 2


class TestConvenienceBuilders:
    def test_make_artist_basic(self):
        ref = make_artist(1, "Drake")
        assert ref == ArtistRef(id=1, name="Drake")

    def test_make_artist_with_extra_fields(self):
        ref = make_artist(1, "Drake", image="img.png", url="http://x")
        assert ref.image == "img.png"
        assert ref.url == "http://x"

    def test_make_song_primary_only(self):
        primary = make_artist(1, "Drake")
        song = make_song(101, "God's Plan", primary)
        assert song.id == 101
        assert len(song.credits) == 1
        assert song.credits[0].role == "primary"
        assert song.credits[0].artist == primary

    def test_make_song_with_collaborators(self):
        primary = make_artist(1, "Drake")
        feat = make_artist(2, "Future")
        producer = make_artist(3, "40")
        song = make_song(
            101,
            "God's Plan",
            primary,
            collaborators=[
                {"artist": feat, "role": "featured"},
                {"artist": producer, "role": "producer"},
            ],
        )
        assert len(song.credits) == 3
        roles = {c.artist.id: c.role for c in song.credits}
        assert roles == {1: "primary", 2: "featured", 3: "producer"}

    def test_make_song_collaborator_default_role_is_featured(self):
        primary = make_artist(1, "Drake")
        other = make_artist(2, "Future")
        song = make_song(101, "Track", primary, collaborators=[{"artist": other}])
        assert song.credits[1].role == "featured"
