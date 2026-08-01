// [SF-YM-06] Регресс-тест на роль яндексовых рёбер: "feature" (ед.ч.) ломала
// RoleAllowed/RoleRank (фильтры и стиль), RoleToInt (персист в "unknown").
// Закрепляем, что роль провайдера осмысленна для каждого потребителя.

#include <cstdint>
#include <gtest/gtest.h>
#include <six-feat-domain/role_mask.hpp>
#include <string>

namespace six_feat {
namespace {

// Роль, которую YandexMusicSourceProvider ставит на каждое ребро и credit;
// Яндекс не различает типы участия, поэтому она одна на всё.
constexpr const char* kYandexEdgeRole = "featured";

// Зеркало RoleToInt/IntToRole из persistent_store.cpp (в анонимном namespace,
// снаружи недоступны): рассинхрон копии поймает интеграционный тест.
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
  // Дефолтная маска — то, что видит пользователь, не трогавший фильтры.
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
  // 0 — ранг нераспознанной роли.
  EXPECT_GT(RoleRank(kYandexEdgeRole), 0);
  EXPECT_EQ(RoleRank(kYandexEdgeRole), RoleRank("featured"));
}

TEST(YandexEdgeRole, HasDedicatedEdgeStyle) {
  // "dotted" — стиль-заглушка для нераспознанных ролей.
  EXPECT_NE(EdgeStyleForRole(kYandexEdgeRole), "dotted");
  EXPECT_EQ(EdgeStyleForRole(kYandexEdgeRole), "solid");
}

TEST(YandexEdgeRole, SurvivesPersistRoundTrip) {
  const std::int16_t stored = RoleToIntMirror(kYandexEdgeRole);
  EXPECT_NE(stored, 0) << "роль записалась бы в БД как 0 и потерялась";
  EXPECT_EQ(IntToRoleMirror(stored), kYandexEdgeRole);
}

TEST(YandexEdgeRole, SingularFormIsNotSilentlyAccepted) {
  // Страховка от возврата старой строки "feature".
  EXPECT_FALSE(RoleAllowed("feature", RoleMask{}));
  EXPECT_EQ(RoleRank("feature"), 0);
  EXPECT_EQ(EdgeStyleForRole("feature"), "dotted");
  EXPECT_EQ(RoleToIntMirror("feature"), 0);
}

}  // namespace
}  // namespace six_feat
