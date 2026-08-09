#pragma once

#include <cstdint>
#include <six-feat-core/lane.hpp>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <string_view>
#include <vector>

namespace six_feat {

// [SF-ARCH-07] Здесь были порт MusicSourceProvider и хелперы цепочки под него
// (ADR-0011: Яндекс — ширина графа, Genius — глубина и fallback). Второго
// провайдера больше нет, порт с единственной реализацией схлопнут: и граф, и
// фоновое обогащение ходят прямо в GeniusMusicSourceProvider. Осталась только
// лексика самого ребра — она описывает данные, а не источник.
// Заголовок при этом остаётся словарём области: lane.hpp и domain_types.hpp
// подключены здесь потому, что ими пользуются все, кто работает с рёбрами и
// песнями провайдера, — не убирать «как неиспользуемые».
// EdgeSource пережил откат намеренно: он подписывает, ОТКУДА пришло ребро, и
// переживает запись в Postgres (ADR-0011, «Идентичность трека»). Значение
// сейчас одно — это метаданные ребра, а не оставленная точка расширения.
enum class EdgeSource : std::uint8_t { kGeniusCredit };

const char* ToString(EdgeSource source);

struct ProviderEdge {
  std::int64_t from{0};
  std::int64_t to{0};
  EdgeSource source{EdgeSource::kGeniusCredit};
  std::string role;
};

}  // namespace six_feat
