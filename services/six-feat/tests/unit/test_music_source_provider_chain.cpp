#include <gtest/gtest.h>
#include <six-feat-common/music_source_provider.hpp>

#include "fakes/fake_music_source_provider.hpp"

namespace six_feat::test {
namespace {

TEST(TryProvidersInOrder, ReturnsFirstProviderResultWhenItSucceeds) {
  FakeMusicSourceProvider yandex("yandex");
  yandex.SucceedWith({ProviderEdge{1, 2, EdgeSource::kYandexFeature, "featured"}});
  FakeMusicSourceProvider genius("genius-fallback");
  genius.SucceedWith({ProviderEdge{1, 3, EdgeSource::kGeniusCredit, "producer"}});

  const std::vector<MusicSourceProvider*> providers{&yandex, &genius};
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
  FakeMusicSourceProvider yandex("yandex");
  yandex.FailWith("yandex unavailable");
  FakeMusicSourceProvider genius("genius-fallback");
  genius.SucceedWith({ProviderEdge{1, 3, EdgeSource::kGeniusCredit, "producer"}});

  const std::vector<MusicSourceProvider*> providers{&yandex, &genius};
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
  EXPECT_EQ(failed_providers[0], "yandex");
}

TEST(TryProvidersInOrder, RethrowsLastErrorWhenEveryProviderFails) {
  FakeMusicSourceProvider yandex("yandex");
  yandex.FailWith("yandex unavailable");
  FakeMusicSourceProvider genius("genius-fallback");
  genius.FailWith("genius unavailable too");

  const std::vector<MusicSourceProvider*> providers{&yandex, &genius};

  EXPECT_THROW(TryProvidersInOrder(providers, ArtistRef{1, "Seed", "", ""}, "token"),
               std::runtime_error);
}

TEST(TryProvidersInOrder, EmptyProviderListReturnsEmptyEdgesWithoutThrowing) {
  const std::vector<MusicSourceProvider*> providers;

  const auto edges = TryProvidersInOrder(providers, ArtistRef{1, "Seed", "", ""}, "token");

  EXPECT_TRUE(edges.empty());
}

TEST(ReorderProvidersPreferring, MovesGeniusPreferenceToFrontMatchingInternalName) {
  FakeMusicSourceProvider yandex("yandex");
  FakeMusicSourceProvider genius("genius-fallback");
  const std::vector<MusicSourceProvider*> providers{&yandex, &genius};

  const auto ordered = ReorderProvidersPreferring(providers, "genius");

  ASSERT_EQ(ordered.size(), 2u);
  EXPECT_EQ(ordered[0]->Name(), "genius-fallback");
  EXPECT_EQ(ordered[1]->Name(), "yandex");
}

TEST(ReorderProvidersPreferring, YandexPreferenceIsAlreadyFrontNoOpButStillWellFormed) {
  FakeMusicSourceProvider yandex("yandex");
  FakeMusicSourceProvider genius("genius-fallback");
  const std::vector<MusicSourceProvider*> providers{&yandex, &genius};

  const auto ordered = ReorderProvidersPreferring(providers, "yandex");

  ASSERT_EQ(ordered.size(), 2u);
  EXPECT_EQ(ordered[0]->Name(), "yandex");
  EXPECT_EQ(ordered[1]->Name(), "genius-fallback");
}

TEST(ReorderProvidersPreferring, EmptyPreferenceReturnsServiceDefaultOrderUnchanged) {
  FakeMusicSourceProvider yandex("yandex");
  FakeMusicSourceProvider genius("genius-fallback");
  const std::vector<MusicSourceProvider*> providers{&yandex, &genius};

  const auto ordered = ReorderProvidersPreferring(providers, "");

  ASSERT_EQ(ordered.size(), 2u);
  EXPECT_EQ(ordered[0]->Name(), "yandex");
  EXPECT_EQ(ordered[1]->Name(), "genius-fallback");
}

TEST(ReorderProvidersPreferring, PreferenceForAProviderNotInThisChainLeavesOrderUnchanged) {
  FakeMusicSourceProvider yandex("yandex");
  const std::vector<MusicSourceProvider*> providers{&yandex};

  const auto ordered = ReorderProvidersPreferring(providers, "genius");

  ASSERT_EQ(ordered.size(), 1u);
  EXPECT_EQ(ordered[0]->Name(), "yandex");
}

}  // namespace
}  // namespace six_feat::test
