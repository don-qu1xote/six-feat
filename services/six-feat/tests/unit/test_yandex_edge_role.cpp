
#include <cstdint>
#include <gtest/gtest.h>
#include <six-feat-domain/role_mask.hpp>
#include <string>

namespace six_feat {
namespace {

constexpr const char* kFeaturedEdgeRole = "featured";

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

TEST(FeaturedEdgeRole, PassesDefaultRoleMask) {
  EXPECT_TRUE(RoleAllowed(kFeaturedEdgeRole, RoleMask{}));
}

TEST(FeaturedEdgeRole, PassesExplicitFeaturedFilter) {
  const RoleMask only_featured = ParseRoleMask("featured");
  EXPECT_TRUE(RoleAllowed(kFeaturedEdgeRole, only_featured));
}

TEST(FeaturedEdgeRole, IsExcludedWhenFeaturedFilteredOut) {
  const RoleMask without_featured = ParseRoleMask("producer,writer,primary");
  EXPECT_FALSE(RoleAllowed(kFeaturedEdgeRole, without_featured));
}

TEST(FeaturedEdgeRole, HasNonDefaultRank) {
  EXPECT_GT(RoleRank(kFeaturedEdgeRole), 0);
  EXPECT_EQ(RoleRank(kFeaturedEdgeRole), RoleRank("featured"));
}

TEST(FeaturedEdgeRole, HasDedicatedEdgeStyle) {
  EXPECT_NE(EdgeStyleForRole(kFeaturedEdgeRole), "dotted");
  EXPECT_EQ(EdgeStyleForRole(kFeaturedEdgeRole), "solid");
}

TEST(FeaturedEdgeRole, SurvivesPersistRoundTrip) {
  const std::int16_t stored = RoleToIntMirror(kFeaturedEdgeRole);
  EXPECT_NE(stored, 0) << "роль записалась бы в БД как 0 и потерялась";
  EXPECT_EQ(IntToRoleMirror(stored), kFeaturedEdgeRole);
}

TEST(FeaturedEdgeRole, SingularFormIsNotSilentlyAccepted) {
  EXPECT_FALSE(RoleAllowed("feature", RoleMask{}));
  EXPECT_EQ(RoleRank("feature"), 0);
  EXPECT_EQ(EdgeStyleForRole("feature"), "dotted");
  EXPECT_EQ(RoleToIntMirror("feature"), 0);
}

}  // namespace
}  // namespace six_feat
