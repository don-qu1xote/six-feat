#include "http/dto/candidate_dto.hpp"

namespace six_feat::dto {

CandidateDto ToDto(const Candidate& candidate) {
  return CandidateDto{
      candidate.id, candidate.name, candidate.image, candidate.url, candidate.score};
}

userver::formats::json::ValueBuilder ToJson(const CandidateDto& dto) {
  userver::formats::json::ValueBuilder b(userver::formats::json::Type::kObject);
  b["id"] = dto.id;
  b["name"] = dto.name;
  if (!dto.image.empty()) b["image"] = dto.image;
  if (!dto.url.empty()) b["url"] = dto.url;
  b["score"] = dto.score;
  return b;
}

}  // namespace six_feat::dto
