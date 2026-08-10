#pragma once

#include <cstdint>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <userver/formats/json/value_builder.hpp>

namespace six_feat::dto {

struct ArtistRefDto {
  std::int64_t id{0};
  std::string name;
  std::string image;
  std::string url;
  // [SF-API-20] Средний цвет фотографии ("#rrggbb"), посчитанный один раз в
  // image-proxy. Пусто — значит «ещё не считали» (в БД NULL); в JSON такое
  // поле не появляется вовсе, а не приходит пустой строкой: клиенту нужно
  // отличать «цвета нет» от «цвет — пустота», и на «нет» у него свой фолбэк
  // (роль-цвет темы).
  std::string dominant_color;
};

ArtistRefDto ToDto(const ArtistRef& ref);

ArtistRefDto ToDto(const ArtistRef& ref, const std::string& dominant_color);

userver::formats::json::ValueBuilder ToJson(const ArtistRefDto& dto);

}  // namespace six_feat::dto
