
#include <cstdint>
#include <gtest/gtest.h>
#include <six-feat-domain/role_mask.hpp>
#include <string>

namespace six_feat {
namespace {

constexpr const char* kYandexEdgeRole = "featured";

std::int16_t RoleToIntMirror(const std::string& role) {
  if (role == "primary") return 1;
  if (role == "featured") return 2;
  if (role == "writer") return 3;
  if (role == "producer") return 4;
  return 0;
}

std::string IntToRoleMirror(std::int16_t r) {
  switch (r) {
    case 1:
      return "primary";
    case 2:
      return "featured";
    case 3:
      return "writer";
    case 4:
      return "producer";
    default:
      return "unknown";
  }
}

TEST(YandexEdgeRole, PassesDefaultRoleMask) {
  EXPECT_TRUE(RoleAllowed(kYandexEdgeRole, RoleMask{}));
}

TEST(YandexEdgeRole, PassesExplicitFeaturedFilter) {
  const RoleMask only_featured = ParseRoleMask("featured");
  EXPECT_TRUE(RoleAllowed(kYandexEdgeRole, only_featured));
}

TEST(YandexEdgeRole, IsExcludedWhenFeaturedFilteredOut) {
  const RoleMask without_featured = ParseRoleMask("producer,writer,primary");
  EXPECT_FALSE(RoleAllowed(kYandexEdgeRole, without_featured));
}

TEST(YandexEdgeRole, HasNonDefaultRank) {
  EXPECT_GT(RoleRank(kYandexEdgeRole), 0);
  EXPECT_EQ(RoleRank(kYandexEdgeRole), RoleRank("featured"));
}

TEST(YandexEdgeRole, HasDedicatedEdgeStyle) {
  EXPECT_NE(EdgeStyleForRole(kYandexEdgeRole), "dotted");
  EXPECT_EQ(EdgeStyleForRole(kYandexEdgeRole), "solid");
}

TEST(YandexEdgeRole, SurvivesPersistRoundTrip) {
  const std::int16_t stored = RoleToIntMirror(kYandexEdgeRole);
  EXPECT_NE(stored, 0) << "роль записалась бы в БД как 0 и потерялась";
  EXPECT_EQ(IntToRoleMirror(stored), kYandexEdgeRole);
}

TEST(YandexEdgeRole, SingularFormIsNotSilentlyAccepted) {
  EXPECT_FALSE(RoleAllowed("feature", RoleMask{}));
  EXPECT_EQ(RoleRank("feature"), 0);
  EXPECT_EQ(EdgeStyleForRole("feature"), "dotted");
  EXPECT_EQ(RoleToIntMirror("feature"), 0);
}

}  // namespace
}  // namespace six_feat
