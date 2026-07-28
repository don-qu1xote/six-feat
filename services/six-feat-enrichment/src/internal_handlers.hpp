#pragma once

#include <six-feat-enrichment/enrichment_worker.hpp>
#include <six-feat-storage/artist_repository.hpp>
#include <six-feat-storage/persistent_store.hpp>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::enrichment {

class EnqueueHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-internal-enqueue";

  EnqueueHandler(const userver::components::ComponentConfig& config,
                 const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  EnrichmentWorker& worker_;
  ArtistRepository& repo_;
  const std::string shared_secret_;
};

class InternalStatusHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-internal-status";

  InternalStatusHandler(const userver::components::ComponentConfig& config,
                        const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  PersistentStore& store_;
  EnrichmentWorker& worker_;
  const std::string shared_secret_;
};

class ReadinessHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-readyz";

  ReadinessHandler(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  PersistentStore& store_;
};

}  // namespace six_feat::enrichment