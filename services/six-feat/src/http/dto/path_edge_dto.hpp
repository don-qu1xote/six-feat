#pragma once

#include <cstdint>
#include <string>
#include <userver/formats/json/value_builder.hpp>
#include <vector>

namespace six_feat::dto {

struct PathEdgeDto {
  std::int64_t from{0};
  std::int64_t to{0};
  int weight{0};
  std::string dominant_role;
  std::string source;
  std::vector<std::string> songs;
};

userver::formats::json::ValueBuilder ToJson(const PathEdgeDto& dto);

}  // namespace six_feat::dto
