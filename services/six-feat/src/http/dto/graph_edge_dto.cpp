#include "http/dto/graph_edge_dto.hpp"

namespace six_feat::dto {

userver::formats::json::ValueBuilder ToJson(const GraphEdgeDto& dto) {
  using userver::formats::json::Type;
  using userver::formats::json::ValueBuilder;

  ValueBuilder eb(Type::kObject);
  eb["from"] = dto.from;
  eb["to"] = dto.to;
  eb["weight"] = dto.weight;
  eb["collaboration_count"] = dto.collaboration_count;
  eb["dominant_role"] = dto.dominant_role;
  eb["edge_style"] = dto.edge_style;
  eb["source"] = dto.source;
  return eb;
}

}  // namespace six_feat::dto
