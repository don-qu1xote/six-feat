#include <gtest/gtest.h>

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

}  // namespace
}  // namespace six_feat::test
