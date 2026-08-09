#pragma once

#include <string>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat::game {

// [SF-GAME-22] Единственный источник правды про минимальную длину пути.
// Раньше min-path-len знал только скедулер, а два других пути создания
// челленджа (админский publish и пользовательский POST /challenge) не
// проверяли её вовсе — прямая коллаборация проходила как челлендж.
// Константу нельзя дублировать по вызывающим: правило одно, читается из
// одной секции конфига, и три компонента берут его отсюда.
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

  // Текст для явного отказа. Скедулер им не пользуется — там нет запроса,
  // который надо отклонить, там пара просто пересэмплируется.
  std::string TooShortMessage(int path_len) const;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  const int min_path_len_;
};

}  // namespace six_feat::game
