#pragma once

// ════════════════════════════════════════════════════════════════════════════
// rate_limit_store_component.hpp  —  [SF-SEC-04]
//
// RateLimitStoreComponent — chooses PerIpRateLimit's backend for the whole
// process via static config (`backend: single|shared`, default "single"),
// so the graph/path/search handlers don't each decide independently.
//
//   backend: single (default) — MakeStore() hands back a FRESH, private
//     InProcessRateLimitStore every call. Each handler still gets its own
//     isolated bucket map exactly like before this ticket (a client's
//     /api/v1/search budget was never shared with their /api/v1/graph
//     budget, and still isn't) — this component only centralizes the
//     "which backend" choice, it doesn't change single-node semantics.
//   backend: shared — MakeStore() hands back the SAME
//     PostgresRateLimitStore instance every call, backed by the
//     `rate_buckets` table on the same Postgres cluster PersistentStore
//     uses (dbname config, default "postgres-db-1"). Every replica of
//     every handler sharing this one component (i.e. every replica of this
//     six-feat process) now enforces the SAME counter — the actual point
//     of this ticket. Handlers namespace their keys (PerIpRateLimit's
//     `name` constructor argument) so different endpoints sharing this one
//     store don't collide in the same table.
// ════════════════════════════════════════════════════════════════════════════

#include "core/rate_limit_store.hpp"

#include <memory>
#include <string>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class RateLimitStoreComponent final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "rate-limit-store";

    RateLimitStoreComponent(const userver::components::ComponentConfig&  config,
                            const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // See the class-level comment above for the single/shared distinction.
    std::shared_ptr<RateLimitStore> MakeStore() const;

private:
    std::string                      backend_;      // "single" | "shared"
    std::shared_ptr<RateLimitStore>  shared_store_;  // only set when backend_ == "shared"
};

} // namespace six_feat
