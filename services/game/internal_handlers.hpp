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

// GET /readyz — unauthenticated readiness probe. [SF-INF-03] Unified body
// shape (six_feat::ReadinessCheck/BuildReadinessBody, see
// libs/six-feat-common/src/http/readiness_common.hpp). At the SF-GAME-10
// skeleton stage this service has no Postgres component and no internal-
// service dependency of its own to poll, so checks{} is empty and it always
// reports ready — an honest reflection of "there is nothing here that
// degrades yet", not a stub left unfinished. SF-GAME-11 adds the game_*
// store; when it does, its Postgres ping belongs in checks{} here (same as
// six-feat's own PersistentStore readiness check).
class ReadinessHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-readyz";

    ReadinessHandler(const userver::components::ComponentConfig&  config,
                     const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();
};

} // namespace six_feat::game
