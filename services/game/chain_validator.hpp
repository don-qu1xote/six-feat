#pragma once

#include <algorithm>
#include <cstdint>
#include <optional>
#include <unordered_map>
#include <vector>

#include "neighbours_client.hpp"

namespace six_feat::game {

enum class ChainValidationStatus {
  kValid,
  kEndpointMismatch,
  kInvalidHop,
  kUnavailable,
};

struct ChainValidationResult {
  ChainValidationStatus status{ChainValidationStatus::kValid};
  std::optional<int> invalid_hop_index;
};

inline ChainValidationResult ValidateChain(const NeighboursClient& client,
                                           std::int64_t from,
                                           std::int64_t to,
                                           const std::vector<std::int64_t>& chain,
                                           int role_mask = 0) {
  if (chain.size() < 2 || chain.front() != from || chain.back() != to) {
    return {ChainValidationStatus::kEndpointMismatch, std::nullopt};
  }

  std::unordered_map<std::int64_t, std::optional<std::vector<std::int64_t>>> cache;

  for (std::size_t i = 0; i + 1 < chain.size(); ++i) {
    const auto a = chain[i];
    const auto b = chain[i + 1];

    auto it = cache.find(a);
    if (it == cache.end()) {
      it = cache.emplace(a, client.Neighbours(a, role_mask)).first;
    }
    const auto& neighbours = it->second;

    if (!neighbours) {
      return {ChainValidationStatus::kUnavailable, std::nullopt};
    }
    if (std::find(neighbours->begin(), neighbours->end(), b) == neighbours->end()) {
      return {ChainValidationStatus::kInvalidHop, static_cast<int>(i)};
    }
  }

  return {ChainValidationStatus::kValid, std::nullopt};
}

}  // namespace six_feat::game