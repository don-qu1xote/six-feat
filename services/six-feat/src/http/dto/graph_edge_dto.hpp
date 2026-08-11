#pragma once

#include <cstdint>
#include <string>
#include <userver/formats/json/value_builder.hpp>

namespace six_feat::dto {

struct GraphEdgeDto {
  std::int64_t from{0};
  std::int64_t to{0};
  int weight{0};
  int collaboration_count{0};
  std::string dominant_role;
  std::string edge_style;
  std::string source;
};

userver::formats::json::ValueBuilder ToJson(const GraphEdgeDto& dto);

}  // namespace six_feat::dto
