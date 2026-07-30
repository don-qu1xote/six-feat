#include "http/dto/edge_source_dto.hpp"

#include <six-feat-common/music_source_provider.hpp>

namespace six_feat::dto {

std::string DeriveEdgeSource(const std::string& /*dominant_role*/) {
  return ToString(EdgeSource::GeniusCredit);
}

}  // namespace six_feat::dto
