#include "http/dto/artist_ref_dto.hpp"

namespace six_feat::dto {

ArtistRefDto ToDto(const ArtistRef& ref) {
  return ArtistRefDto{ref.id, ref.name, ref.image, ref.url, {}};
}

ArtistRefDto ToDto(const ArtistRef& ref, const std::string& dominant_color) {
  return ArtistRefDto{ref.id, ref.name, ref.image, ref.url, dominant_color};
}

userver::formats::json::ValueBuilder ToJson(const ArtistRefDto& dto) {
  userver::formats::json::ValueBuilder b(userver::formats::json::Type::kObject);
  b["id"] = dto.id;
  b["name"] = dto.name;
  if (!dto.image.empty()) b["image"] = dto.image;
  if (!dto.url.empty()) b["url"] = dto.url;
  if (!dto.dominant_color.empty()) b["dominant_color"] = dto.dominant_color;
  return b;
}

}  // namespace six_feat::dto
