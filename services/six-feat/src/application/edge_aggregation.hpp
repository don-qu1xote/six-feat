#pragma once

#include <cstdint>
#include <set>
#include <six-feat-domain/domain_types.hpp>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace six_feat {

// [SF-API-23] Свод рёбер вокруг сида — общий для графа и деталей ребра.
// Раньше эта арифметика жила прямо в graph_handler.cpp, и когда список
// совместных треков переехал в отдельную ручку, у него было ровно два пути:
// повторить свод у себя или взять готовый. Повторить — значит завести второй
// алгоритм на те же данные; они разойдутся молча, и пользователь увидит в
// панели ребра не тот набор треков, который сервер посчитал для графа
// (SF-API-24 — ровно про эту ошибку, только в другом месте). Поэтому свод
// один, а ручки разные.
struct EdgeAggregation {
  struct Collaboration {
    std::string song;
    std::vector<std::string> roles;
    std::int64_t popularity{0};
  };

  int weight{0};
  int best_rank{0};
  std::string dominant_role{"featured"};
  // [SF-WEB-77] Все роли ребра, а не только доминирующая: клиент собирал этот
  // набор сам, разбирая collaborations, — теперь получает готовым. std::set,
  // а не unordered: порядок в ответе должен быть стабильным, иначе одинаковый
  // граф даёт разный JSON от запроса к запросу.
  std::set<std::string> roles;
  std::string name, image, url;
  std::vector<Collaboration> collaborations;
  std::unordered_set<std::string> seen_titles;
};

struct EdgeAggregationResult {
  std::unordered_map<std::int64_t, EdgeAggregation> by_neighbour;
  // Порядок первого появления соседа — им задаётся порядок узлов и рёбер в
  // ответе графа, и его нельзя заменить обходом unordered_map.
  std::vector<std::int64_t> order;
};

// Приводит заголовок к виду, по которому треки считаются одним и тем же:
// регистр и лишние пробелы значения не имеют. Публичная, потому что по этому
// же ключу схлопывает дубликаты и ручка деталей ребра.
std::string NormalizedTitle(const std::string& title);

EdgeAggregationResult AggregateEdges(const ArtistSongs& data,
                                     std::int64_t seed_id,
                                     const RoleMask& mask);

// Совместные треки одной пары в том же порядке, в каком они уходили в ответе
// графа: по убыванию популярности, stable_sort — при равной популярности
// (частый случай «данных нет», все нули) сохраняется порядок появления.
std::vector<EdgeAggregation::Collaboration> SortedByPopularity(
    std::vector<EdgeAggregation::Collaboration> collaborations);

}  // namespace six_feat
