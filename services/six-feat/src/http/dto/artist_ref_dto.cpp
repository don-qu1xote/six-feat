#include "http/dto/artist_ref_dto.hpp"

namespace six_feat::dto {

ArtistRefDto ToDto(const ArtistRef& ref) {
  return ArtistRefDto{ref.id, ref.name, ref.image, ref.url};
}

userver::formats::json::ValueBuilder ToJson(const ArtistRefDto& dto) {
  userver::formats::json::ValueBuilder b(userver::formats::json::Type::kObject);
  b["id"] = dto.id;
  b["name"] = dto.name;
  if (!dto.image.empty()) b["image"] = dto.image;
  if (!dto.url.empty()) b["url"] = dto.url;
  return b;
}

}  // namespace six_feat::dto
