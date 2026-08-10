#pragma once

#include <cstdint>
#include <string>
#include <userver/formats/json/value_builder.hpp>

namespace six_feat::dto {

// [SF-API-23] Ребро графа несёт только агрегат. Список совместных треков
// уехал в /api/v1/graph/edge: за сессию раскрывают одно-два ребра, а платили
// разбором и удержанием в памяти всех.
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
