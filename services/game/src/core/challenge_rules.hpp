#pragma once

#include <string>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

class ChallengeRules final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "challenge-rules";

  ChallengeRules(const userver::components::ComponentConfig& config,
                 const userver::components::ComponentContext& context);

  int MinPathLen() const {
    return min_path_len_;
  }

  bool PathLenOk(int path_len) const {
    return path_len >= min_path_len_;
  }

  std::string TooShortMessage(int path_len) const;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  const int min_path_len_;
};

}  // namespace six_feat::game
