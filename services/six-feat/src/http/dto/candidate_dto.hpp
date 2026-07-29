#pragma once

#include <cstdint>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <userver/formats/json/value_builder.hpp>

namespace six_feat::dto {

struct CandidateDto {
  std::int64_t id{0};
  std::string name;
  std::string image;
  std::string url;
  double score{0.0};
};

CandidateDto ToDto(const Candidate& candidate);

userver::formats::json::ValueBuilder ToJson(const CandidateDto& dto);

}  // namespace six_feat::dto
