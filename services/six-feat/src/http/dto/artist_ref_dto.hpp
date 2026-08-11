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

  std::string dominant_color;
};

ArtistRefDto ToDto(const ArtistRef& ref);

ArtistRefDto ToDto(const ArtistRef& ref, const std::string& dominant_color);

userver::formats::json::ValueBuilder ToJson(const ArtistRefDto& dto);

}  // namespace six_feat::dto
