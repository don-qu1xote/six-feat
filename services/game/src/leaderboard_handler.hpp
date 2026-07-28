#pragma once

#include <chrono>
#include <string>
#include <string_view>
#include <unordered_map>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class GameStore;

class LeaderboardHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-game-leaderboard";

  LeaderboardHandler(const userver::components::ComponentConfig& config,
                     const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  struct CacheEntry {
    std::string body;
    std::chrono::steady_clock::time_point expires_at;
  };

  const GameStore& store_;
  const std::chrono::milliseconds cache_ttl_;

  mutable userver::engine::Mutex cache_mu_;
  mutable std::unordered_map<std::string, CacheEntry> cache_;
};

}  // namespace six_feat::game