#pragma once

#include <cstdint>
#include <six-feat-core/lane.hpp>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <string_view>
#include <vector>

namespace six_feat {

enum class EdgeSource : std::uint8_t { kGeniusCredit };

const char* ToString(EdgeSource source);

struct ProviderEdge {
  std::int64_t from{0};
  std::int64_t to{0};
  EdgeSource source{EdgeSource::kGeniusCredit};
  std::string role;
};

}  // namespace six_feat
