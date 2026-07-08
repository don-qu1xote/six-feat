#pragma once

// Internal HTTP API for six-feat-enrichment (IDEA-25). Not meant for
// external clients — every handler except HealthHandler requires the
// X-Internal-Secret header to match ENRICHMENT_INTERNAL_SECRET
// (see src/internal_auth.hpp).

#include "storage/artist_repository.hpp"
#include "enrichment/enrichment_worker.hpp"
#include "storage/persistent_store.hpp"

#include <string_view>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::enrichment {

// POST /internal/enqueue
// Body: {"artist_id": <int64>, "name"?: <string>, "image"?: <string>,
//        "url"?: <string>, "user_token": <string>}
class EnqueueHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-internal-enqueue";

    EnqueueHandler(const userver::components::ComponentConfig&  config,
                   const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    EnrichmentWorker& worker_;
    ArtistRepository& repo_;
    const std::string shared_secret_;
};

// GET /internal/status?id=<artist_id>
class InternalStatusHandler final
    : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-internal-status";

    InternalStatusHandler(const userver::components::ComponentConfig&  config,
                          const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

private:
    PersistentStore&  store_;
    EnrichmentWorker& worker_;
    const std::string shared_secret_;
};

// GET /healthz — unauthenticated liveness probe for Docker HEALTHCHECK.
class HealthHandler final : public userver::server::handlers::HttpHandlerBase {
public:
    static constexpr std::string_view kName = "handler-internal-healthz";

    HealthHandler(const userver::components::ComponentConfig&  config,
                  const userver::components::ComponentContext& context);

    std::string HandleRequestThrow(
        const userver::server::http::HttpRequest&  request,
        userver::server::request::RequestContext&  context) const override;

    static userver::yaml_config::Schema GetStaticConfigSchema();
};

} // namespace six_feat::enrichment
