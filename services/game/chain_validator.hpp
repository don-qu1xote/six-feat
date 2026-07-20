#pragma once

// ════════════════════════════════════════════════════════════════════════════
// chain_validator.hpp — [SF-GAME-14] Server-side anti-cheat: verify every hop
// of a submitted chain is a REAL Genius collaboration, via six-feat's
// /internal/neighbours (see neighbours_client.hpp) — never the client's own
// claim of validity, which this file never even looks at.
//
// For chain = [a0, a1, ..., ak], checks:
//   - a0 == from and ak == to (the submitted attempt actually answers the
//     challenge it claims to, not just any chain of real hops)
//   - every consecutive pair (a_i, a_{i+1}) is a real collaboration
//     (a_{i+1} is confirmed among a_i's neighbours)
//
// Neighbour lookups are cached per artist_id WITHIN one Validate() call — a
// chain frequently revisits an artist across builder mistakes/undo, and this
// avoids paying a redundant round-trip for the same artist twice in one
// attempt. The cache is never reused across calls: a stale cache would let a
// since-added collaboration go unrecognized, or a since-removed one linger as
// "real".
//
// Header-only, no component — same shape as game_session.hpp.
// ════════════════════════════════════════════════════════════════════════════

#include "neighbours_client.hpp"

#include <algorithm>
#include <cstdint>
#include <optional>
#include <unordered_map>
#include <vector>

namespace six_feat::game {

enum class ChainValidationStatus {
    kValid,
    kEndpointMismatch,  // chain too short, or doesn't start/end at from/to
    kInvalidHop,        // a specific transition isn't a real collaboration
    kUnavailable,       // couldn't confirm NOR deny — six-feat lookup failed
};

struct ChainValidationResult {
    ChainValidationStatus status{ChainValidationStatus::kValid};
    // Set only when status == kInvalidHop: 0-based index of the FIRST bad
    // transition (chain[i] -> chain[i+1]). Transitions after it were never
    // actually checked (no point once the chain is already broken).
    std::optional<int> invalid_hop_index;
};

inline ChainValidationResult ValidateChain(
    const NeighboursClient&          client,
    std::int64_t                     from,
    std::int64_t                     to,
    const std::vector<std::int64_t>& chain,
    int                               role_mask = 0)
{
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

} // namespace six_feat::game
