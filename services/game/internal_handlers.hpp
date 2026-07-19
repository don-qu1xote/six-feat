#pragma once

// six-feat-game internal/health handlers (SF-GAME-10 skeleton). Only the
// readiness probe lives here for now; the internal game API (submit-rate
// limiting, /internal calls, etc.) arrives across sprint 13. Modeled on
// services/auth/internal_handlers.hpp.

#include <string>
#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;

// GET /readyz — unauthenticated readiness probe. [SF-INF-03] Unified body
// shape (six_feat::ReadinessCheck/BuildReadinessBody, see
// libs/six-feat-common/src/http/readiness_common.hpp). [SF-GAME-11] With the
// game store landed, this service now has one runtime-degradable dependency —
// its Postgres cluster — so checks{} carries a single "database" check
// (GameStore::Ping), exactly like six-feat's own ReadinessHandler. Reports
// 503 not_ready while Postgres is unreachable (e.g. still starting up), which
// correctly keeps the container out of nginx's rotation until the DB is up.
class ReadinessHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-readyz";

    ReadinessHandler(const userver::components::ComponentConfig&  config,
                     const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    const GameStore& store_;
};

} // namespace six_feat::game
