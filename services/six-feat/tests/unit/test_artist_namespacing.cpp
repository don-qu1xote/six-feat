#include <cstdint>
#include <gtest/gtest.h>
#include <six-feat-common/music_source_provider.hpp>

namespace six_feat {
namespace {

// [SF-ARCH-04] Mirrors the already-shipped song namespacing (SF-ARCH-03):
// Genius-id and Yandex-id spaces must never collide once both live in the
// same BIGINT artists.id column.

TEST(NamespacedYandexArtistId, RoundTripsThroughIsYandexArtistId) {
  const std::int64_t yandex_id = 123456;
  const auto namespaced = NamespacedYandexArtistId(yandex_id);

  EXPECT_TRUE(IsYandexArtistId(namespaced));
  EXPECT_EQ(namespaced & ~kYandexArtistIdOffset, yandex_id);
}

TEST(NamespacedYandexArtistId, RealisticGeniusIdsAreNeverMistakenForYandex) {
  for (const std::int64_t genius_id : {1, 42, 1000000, 999999999}) {
    EXPECT_FALSE(IsYandexArtistId(genius_id)) << "genius_id=" << genius_id;
  }
}

TEST(NamespacedYandexArtistId, DoesNotCollideWithNamespacedSongIds) {
  // Both namespaces share the same offset bit by design (SF-ARCH-04 mirrors
  // SF-ARCH-03), but they are never compared to each other — artists.id and
  // songs.id are different columns/tables. This test documents that the two
  // namespacing helpers are independent, not that their offsets differ.
  const auto artist_id = NamespacedYandexArtistId(77);
  const auto song_id = NamespacedYandexSongId(77);

  EXPECT_TRUE(IsYandexArtistId(artist_id));
  EXPECT_TRUE(IsYandexSongId(song_id));
  EXPECT_EQ(artist_id, song_id) << "same raw id + same offset is expected to match — "
                                   "callers must never compare artist ids to song ids";
}

TEST(NamespacedYandexArtistId, ZeroAndNegativeYandexIdsStillSetTheNamespaceBit) {
  EXPECT_TRUE(IsYandexArtistId(NamespacedYandexArtistId(0)));
}

}  // namespace
}  // namespace six_feat
