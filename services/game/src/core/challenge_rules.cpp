#include "challenge_rules.hpp"

#include "schemas/components/challenge_rules_schema.hpp"

#include <stdexcept>
#include <string>
#include <string_view>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::game {

using namespace userver;

namespace {

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("challenge-rules: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

}  // namespace

ChallengeRules::ChallengeRules(const components::ComponentConfig& config,
                               const components::ComponentContext& context)
    : ComponentBase(config, context),
      min_path_len_(RequirePositive("min-path-len", config["min-path-len"].As<int>(2))) {}

std::string ChallengeRules::TooShortMessage(int path_len) const {
  return "these artists are " + std::to_string(path_len) + " step" + (path_len == 1 ? "" : "s") +
         " apart" + (path_len == 1 ? " (a direct collaboration)" : "") +
         " — a challenge must require at least " + std::to_string(min_path_len_) + " steps";
}

yaml_config::Schema ChallengeRules::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kChallengeRulesComponentSchema);
}

}  // namespace six_feat::game
