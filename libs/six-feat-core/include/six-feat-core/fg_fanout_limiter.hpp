#pragma once

#include <cstddef>
#include <string_view>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/semaphore.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

// [SF-ARCH-03] Один ограничитель на одну foreground-полосу гейтвея.
//
// Фан-аут по деталям треков делают два независимых места: сборка графа
// (GeniusMusicSourceProvider::GetArtistSongs) и проверка прямого ребра
// (CollabService::CheckDirectPath). Пока у каждого был свой семафор со своим
// дефолтом 6, суммарный потолок клиента составлял 12 при полосе гейтвея
// lane-fg-max-concurrent: 8 — обещание схемы «stay at or under the gateway's
// own lane» держалось только на честном слове и ломалось молча, стоило
// появиться второму потребителю.
//
// Компонент делает инвариант выражаемым: лимит один, живёт в одном месте
// конфига и не зависит от того, сколько потребителей его делят.
class FgFanoutLimiter final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "fg-fanout-limiter";

  FgFanoutLimiter(const userver::components::ComponentConfig& config,
                  const userver::components::ComponentContext& context);

  static userver::yaml_config::Schema GetStaticConfigSchema();

  // Общий на все потребители: захват блокирует, пока полоса занята.
  userver::engine::Semaphore& Semaphore() const {
    return semaphore_;
  }

  std::size_t Limit() const {
    return limit_;
  }

 private:
  const std::size_t limit_;
  mutable userver::engine::Semaphore semaphore_;
};

}  // namespace six_feat
