#include <gtest/gtest.h>
#include <six-feat-common/music_source_provider.hpp>

#include "application/artist_resolver.hpp"
#include "fakes/fake_artist_data_source.hpp"
#include "fakes/fake_external_artist_lookup.hpp"

namespace six_feat::test {
namespace {

TEST(ResolveArtistById, ReturnsRepoHitWithoutTouchingGateway) {
  FakeArtistDataSource repo;
  FakeExternalArtistLookup gateway;
  repo.AddArtist(ArtistRef{42, "Known Artist", "", ""});
  const auto result = ResolveArtistById(repo, gateway, 42, "token");

  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->id, 42);
  EXPECT_EQ(result->name, "Known Artist");
}

TEST(ResolveArtistById, FallsBackToGatewayOnRepoMiss) {
  FakeArtistDataSource repo;
  FakeExternalArtistLookup gateway;
  gateway.SetArtistById(99, ArtistRef{99, "Fetched Artist", "", ""});

  const auto result = ResolveArtistById(repo, gateway, 99, "token");

  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->id, 99);
  EXPECT_EQ(result->name, "Fetched Artist");
}

TEST(ResolveArtistById, ReturnsNulloptWhenNeitherRepoNorGatewayKnowsIt) {
  FakeArtistDataSource repo;
  FakeExternalArtistLookup gateway;

  const auto result = ResolveArtistById(repo, gateway, 7, "token");

  EXPECT_FALSE(result.has_value());
}

// [SF-ARCH-04] A Yandex-namespaced id that misses the repo must NOT fall
// through to Genius — Genius can never recognise it, so that call would be
// wasted at best and a wrong-provider error at worst.
TEST(ResolveArtistById, SkipsGatewayEntirelyForUncachedYandexNamespacedId) {
  FakeArtistDataSource repo;
  FakeExternalArtistLookup gateway;
  const auto yandex_id = NamespacedYandexArtistId(555);
  gateway.SetArtistById(yandex_id, ArtistRef{yandex_id, "Should never be returned", "", ""});

  const auto result = ResolveArtistById(repo, gateway, yandex_id, "token");

  EXPECT_FALSE(result.has_value());
}

TEST(ResolveArtistById, StillUsesRepoHitForYandexNamespacedId) {
  FakeArtistDataSource repo;
  FakeExternalArtistLookup gateway;
  const auto yandex_id = NamespacedYandexArtistId(555);
  repo.AddArtist(ArtistRef{yandex_id, "Cached Yandex Artist", "", ""});

  const auto result = ResolveArtistById(repo, gateway, yandex_id, "token");

  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->name, "Cached Yandex Artist");
}

TEST(ResolveArtistByName, ReturnsBestCandidateAboveThreshold) {
  FakeExternalArtistLookup gateway;
  gateway.SetMatchThreshold(0.5);
  gateway.SetCandidates("drake",
                        {Candidate{1, "Drake", "img1", "url1", 0.95},
                         Candidate{2, "Drake (tribute)", "img2", "url2", 0.4}});

  const auto result = ResolveArtistByName(gateway, "drake", "token");

  ASSERT_TRUE(std::holds_alternative<ArtistRef>(result));
  const auto& ref = std::get<ArtistRef>(result);
  EXPECT_EQ(ref.id, 1);
  EXPECT_EQ(ref.name, "Drake");
}

TEST(ResolveArtistByName, ReturnsAmbiguousWhenNoCandidatesFound) {
  FakeExternalArtistLookup gateway;

  const auto result = ResolveArtistByName(gateway, "nonexistent artist xyz", "token");

  ASSERT_TRUE(std::holds_alternative<AmbiguousResult>(result));
  const auto& ambiguous = std::get<AmbiguousResult>(result);
  EXPECT_EQ(ambiguous.query, "nonexistent artist xyz");
  EXPECT_TRUE(ambiguous.candidates.empty());
}

TEST(ResolveArtistByName, ReturnsAmbiguousWithCappedCandidatesWhenBestScoreBelowThreshold) {
  FakeExternalArtistLookup gateway;
  gateway.SetMatchThreshold(0.9);
  std::vector<Candidate> many;
  for (int i = 0; i < 8; ++i) {
    many.push_back(Candidate{i, "Artist " + std::to_string(i), "", "", 0.3});
  }
  gateway.SetCandidates("ambiguous query", many);

  const auto result = ResolveArtistByName(gateway, "ambiguous query", "token");

  ASSERT_TRUE(std::holds_alternative<AmbiguousResult>(result));
  const auto& ambiguous = std::get<AmbiguousResult>(result);
  EXPECT_EQ(ambiguous.query, "ambiguous query");
  EXPECT_EQ(ambiguous.candidates.size(), 6u);
}

// [SF-YM-08] Резолв имени из уже известного репозиторию, без внешнего
// гейтвея (Genius/Yandex) — единственный поиск по имени, доступный
// Yandex-only сессии без BYO Genius-токена.
TEST(ResolveArtistByNameFromCache, ReturnsNulloptWhenRepoHasNoMatch) {
  FakeArtistDataSource repo;
  repo.AddArtist(ArtistRef{1, "Someone Else", "", ""});

  const auto result = ResolveArtistByNameFromCache(repo, "Gorillaz");

  EXPECT_FALSE(result.has_value());
}

TEST(ResolveArtistByNameFromCache, ReturnsTheSingleSubstringMatch) {
  FakeArtistDataSource repo;
  repo.AddArtist(ArtistRef{42, "Gorillaz", "img", "url"});

  const auto result = ResolveArtistByNameFromCache(repo, "gorillaz");

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<ArtistRef>(*result));
  const auto& ref = std::get<ArtistRef>(*result);
  EXPECT_EQ(ref.id, 42);
  EXPECT_EQ(ref.name, "Gorillaz");
}

TEST(ResolveArtistByNameFromCache, PrefersExactCaseInsensitiveMatchAmongMultipleSubstringHits) {
  FakeArtistDataSource repo;
  repo.AddArtist(ArtistRef{1, "Drake", "", ""});
  repo.AddArtist(ArtistRef{2, "Drake (tribute)", "", ""});
  repo.AddArtist(ArtistRef{3, "Lil Drake", "", ""});

  const auto result = ResolveArtistByNameFromCache(repo, "drake");

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<ArtistRef>(*result));
  EXPECT_EQ(std::get<ArtistRef>(*result).id, 1);
}

TEST(ResolveArtistByNameFromCache, ReturnsAmbiguousWhenMultipleSubstringHitsAndNoExactMatch) {
  FakeArtistDataSource repo;
  repo.AddArtist(ArtistRef{1, "Drake (tribute)", "", ""});
  repo.AddArtist(ArtistRef{2, "Lil Drake", "", ""});

  const auto result = ResolveArtistByNameFromCache(repo, "drake");

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<AmbiguousResult>(*result));
  EXPECT_EQ(std::get<AmbiguousResult>(*result).candidates.size(), 2u);
}

}  // namespace
}  // namespace six_feat::test
