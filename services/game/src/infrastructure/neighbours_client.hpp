#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat::game {

class NeighboursClient final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "neighbours-client";

  NeighboursClient(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::optional<std::vector<std::int64_t>> Neighbours(std::int64_t artist_id,
                                                      int role_mask = 0) const;

  bool IsRealHop(std::int64_t from, std::int64_t to, int role_mask = 0) const;

 private:
  userver::clients::http::Client& http_client_;
  const std::string base_url_;
  const std::string shared_secret_;
  const std::chrono::milliseconds timeout_;
};

}  // namespace six_feat::game