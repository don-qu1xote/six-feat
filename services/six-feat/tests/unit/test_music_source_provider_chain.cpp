#include <gtest/gtest.h>
#include <six-feat-common/music_source_provider.hpp>

#include "fakes/fake_music_source_provider.hpp"

namespace six_feat::test {
namespace {

TEST(TryProvidersInOrder, ReturnsFirstProviderResultWhenItSucceeds) {
  FakeMusicSourceProvider first("alt-provider");
  first.SucceedWith({ProviderEdge{1, 2, EdgeSource::kGeniusCredit, "featured"}});
  FakeMusicSourceProvider genius("genius-fallback");
  genius.SucceedWith({ProviderEdge{1, 3, EdgeSource::kGeniusCredit, "producer"}});

  const std::vector<MusicSourceProvider*> providers{&first, &genius};
  bool fallback_logged = false;

  const auto edges = TryProvidersInOrder(
      providers,
      ArtistRef{1, "Seed", "", ""},
      "token",
      [&fallback_logged](std::string_view, const std::exception&) { fallback_logged = true; });

  ASSERT_EQ(edges.size(), 1u);
  EXPECT_EQ(edges[0].to, 2);
  EXPECT_FALSE(fallback_logged);
}

TEST(TryProvidersInOrder, FallsBackToNextProviderWhenFirstThrows) {
  FakeMusicSourceProvider first("alt-provider");
  first.FailWith("alt-provider unavailable");
  FakeMusicSourceProvider genius("genius-fallback");
  genius.SucceedWith({ProviderEdge{1, 3, EdgeSource::kGeniusCredit, "producer"}});

  const std::vector<MusicSourceProvider*> providers{&first, &genius};
  std::vector<std::string> failed_providers;

  const auto edges =
      TryProvidersInOrder(providers,
                          ArtistRef{1, "Seed", "", ""},
                          "token",
                          [&failed_providers](std::string_view name, const std::exception&) {
                            failed_providers.emplace_back(name);
                          });

  ASSERT_EQ(edges.size(), 1u);
  EXPECT_EQ(edges[0].to, 3);
  EXPECT_EQ(edges[0].source, EdgeSource::kGeniusCredit);
  ASSERT_EQ(failed_providers.size(), 1u);
  EXPECT_EQ(failed_providers[0], "alt-provider");
}

TEST(TryProvidersInOrder, RethrowsLastErrorWhenEveryProviderFails) {
  FakeMusicSourceProvider first("alt-provider");
  first.FailWith("alt-provider unavailable");
  FakeMusicSourceProvider genius("genius-fallback");
  genius.FailWith("genius unavailable too");

  const std::vector<MusicSourceProvider*> providers{&first, &genius};

  EXPECT_THROW(TryProvidersInOrder(providers, ArtistRef{1, "Seed", "", ""}, "token"),
               std::runtime_error);
}

TEST(TryProvidersInOrder, EmptyProviderListReturnsEmptyEdgesWithoutThrowing) {
  const std::vector<MusicSourceProvider*> providers;

  const auto edges = TryProvidersInOrder(providers, ArtistRef{1, "Seed", "", ""}, "token");

  EXPECT_TRUE(edges.empty());
}

TEST(ReorderProvidersPreferring, MovesGeniusPreferenceToFrontMatchingInternalName) {
  FakeMusicSourceProvider first("alt-provider");
  FakeMusicSourceProvider genius("genius-fallback");
  const std::vector<MusicSourceProvider*> providers{&first, &genius};

  const auto ordered = ReorderProvidersPreferring(providers, "genius");

  ASSERT_EQ(ordered.size(), 2u);
  EXPECT_EQ(ordered[0]->Name(), "genius-fallback");
  EXPECT_EQ(ordered[1]->Name(), "alt-provider");
}

TEST(ReorderProvidersPreferring, NonFrontPreferenceIsMovedToFront) {
  FakeMusicSourceProvider first("alt-provider");
  FakeMusicSourceProvider genius("genius-fallback");
  const std::vector<MusicSourceProvider*> providers{&first, &genius};

  const auto ordered = ReorderProvidersPreferring(providers, "alt-provider");

  ASSERT_EQ(ordered.size(), 2u);
  EXPECT_EQ(ordered[0]->Name(), "alt-provider");
  EXPECT_EQ(ordered[1]->Name(), "genius-fallback");
}

TEST(ReorderProvidersPreferring, EmptyPreferenceReturnsServiceDefaultOrderUnchanged) {
  FakeMusicSourceProvider first("alt-provider");
  FakeMusicSourceProvider genius("genius-fallback");
  const std::vector<MusicSourceProvider*> providers{&first, &genius};

  const auto ordered = ReorderProvidersPreferring(providers, "");

  ASSERT_EQ(ordered.size(), 2u);
  EXPECT_EQ(ordered[0]->Name(), "alt-provider");
  EXPECT_EQ(ordered[1]->Name(), "genius-fallback");
}

TEST(ReorderProvidersPreferring, PreferenceForAProviderNotInThisChainLeavesOrderUnchanged) {
  FakeMusicSourceProvider first("alt-provider");
  const std::vector<MusicSourceProvider*> providers{&first};

  const auto ordered = ReorderProvidersPreferring(providers, "genius");

  ASSERT_EQ(ordered.size(), 1u);
  EXPECT_EQ(ordered[0]->Name(), "alt-provider");
}

}  // namespace
}  // namespace six_feat::test
