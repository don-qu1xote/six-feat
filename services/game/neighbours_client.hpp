#pragma once

// ════════════════════════════════════════════════════════════════════════════
// neighbours_client.hpp — [SF-GAME-13]
//
// Outbound client for six-feat's internal anti-cheat endpoint
// (POST /internal/neighbours, services/six-feat/src/http/
// internal_neighbours_handler.cpp): the only way six-feat-game can verify a
// player-submitted hop A→B is a REAL collaboration, since this service has
// no Genius credentials of its own and must not talk to Genius directly.
//
// Modeled on services/six-feat/src/enrichment/enrichment_client.cpp's own
// internal-mesh client (core/internal_http transport, core/internal_auth
// shared secret) but deliberately without its retry queue / response cache —
// this is a synchronous verification check on a player action, not a
// fire-and-forget background job, so there is nothing useful to retry later.
//
// Every failure mode (network error, timeout, non-2xx, malformed JSON) is
// caught internally and degrades to nullopt/false, never an exception —
// callers (GAME-14/15's submit/validate flow) must treat that as "can't
// confirm" and fail closed, exactly like IsRealHop's own doc-comment says.
// ════════════════════════════════════════════════════════════════════════════

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class NeighboursClient final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "neighbours-client";

    NeighboursClient(const userver::components::ComponentConfig&  config,
                      const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // Real one-hop neighbours of `artist_id` from six-feat's L1
    // (role_mask bits: primary=1, producer=2, writer=4, featured=8; 0 or
    // omitted means "all four" — same convention
    // internal_neighbours_handler.cpp decodes). nullopt on any failure
    // (network error, timeout, non-2xx, malformed body) — distinct from an
    // empty-but-successful lookup, so callers can tell "confirmed no such
    // hop" apart from "couldn't ask".
    std::optional<std::vector<std::int64_t>>
    Neighbours(std::int64_t artist_id, int role_mask = 0) const;

    // Convenience wrapper: true only if `to` is confirmed among `from`'s
    // real neighbours. False both on a genuinely absent hop AND on a failed
    // lookup — fail-closed, since an unreachable six-feat must never let an
    // unverified hop through as "verified".
    bool IsRealHop(std::int64_t from, std::int64_t to, int role_mask = 0) const;

private:
    userver::clients::http::Client& http_client_;
    const std::string               base_url_;
    const std::string               shared_secret_;
    const std::chrono::milliseconds timeout_;
};

} // namespace six_feat::game
