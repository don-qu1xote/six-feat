#pragma once

#include <array>
#include <string>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat::game {

class ChallengeRules;
class GameStore;
class NeighboursClient;
struct Player;

class AdminHandler final : public userver::server::handlers::HttpHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-game-admin";

  AdminHandler(const userver::components::ComponentConfig& config,
               const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  bool IsAdmin(const Player& player) const;

  const GameStore& store_;
  const NeighboursClient& neighbours_;
  const ChallengeRules& rules_;
  std::array<unsigned char, 32> session_key_;
  std::vector<std::string> admin_ids_;
};

}  // namespace six_feat::game