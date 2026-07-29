#include "http/dto/path_edge_dto.hpp"

namespace six_feat::dto {

userver::formats::json::ValueBuilder ToJson(const PathEdgeDto& dto) {
  using userver::formats::json::Type;
  using userver::formats::json::ValueBuilder;

  ValueBuilder eb(Type::kObject);
  eb["from"] = dto.from;
  eb["to"] = dto.to;
  eb["weight"] = dto.weight;
  eb["dominant_role"] = dto.dominant_role;
  eb["source"] = dto.source;
  ValueBuilder songs_arr(Type::kArray);
  for (const auto& s : dto.songs) songs_arr.PushBack(s);
  eb["songs"] = std::move(songs_arr);
  return eb;
}

}  // namespace six_feat::dto
