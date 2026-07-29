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

  ValueBuilder cb(Type::kArray);
  for (const auto& c : dto.collaborations) {
    ValueBuilder ci(Type::kObject);
    ci["song"] = c.song;
    ci["popularity"] = c.popularity;
    ValueBuilder rb(Type::kArray);
    for (const auto& r : c.roles) rb.PushBack(r);
    ci["roles"] = std::move(rb);
    cb.PushBack(std::move(ci));
  }
  eb["collaborations"] = std::move(cb);
  return eb;
}

}  // namespace six_feat::dto
