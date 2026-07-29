#include "http/dto/edge_source_dto.hpp"

#include <six-feat-common/music_source_provider.hpp>

namespace six_feat::dto {

std::string DeriveEdgeSource(const std::string& dominant_role) {
  const EdgeSource source =
      dominant_role == "feature" ? EdgeSource::YandexFeature : EdgeSource::GeniusCredit;
  return ToString(source);
}

}  // namespace six_feat::dto
