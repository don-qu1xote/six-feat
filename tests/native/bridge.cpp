/// Плоский C-ABI поверх чистых библиотек, чтобы их звали из pytest через ctypes.
///
/// Сам по себе он ничего не считает и ничего не проверяет: только раскладывает
/// массивы из Python в структуры libs/six-feat-layout и libs/six-feat-image и
/// складывает ответ обратно в массивы. Тесты живут в tests/test_layout_geometry.py
/// и tests/test_dominant_color.py; здесь — переходник, чтобы C++-код мерялся
/// покрытием из того же прогона pytest, что и всё остальное на бэкенде.

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <six-feat-image/dominant_color.hpp>
#include <six-feat-layout/layout.hpp>

namespace {

using six_feat::layout::LayoutParams;
using six_feat::layout::LayoutRequest;
using six_feat::layout::Point;

LayoutParams MakeParams(double node_radius, double node_gap) {
  LayoutParams params;
  params.node_radius = node_radius;
  params.node_gap = node_gap;
  return params;
}

}  // namespace

extern "C" {

/// Средний цвет картинки: 1 и семь байт "#rrggbb\0" в out, либо 0 и out нетронут.
std::int32_t sf_dominant_color_hex(const void* bytes, std::size_t size, char* out) {
  const std::optional<std::string> colour = six_feat::image::DominantColorHex(bytes, size);
  if (!colour) {
    return 0;
  }
  std::memcpy(out, colour->c_str(), colour->size() + 1);
  return 1;
}

/// Раскладка: возвращает длину order, либо -1, если она не влезла в capacity.
///
/// Рёбра и пары «раскрытый узел — его родитель» приходят сплющенными по два
/// значения подряд, закреплённые позиции — идентификаторами и парами координат.
/// out_ids/out_xy заполняются в порядке order, out_position_count отдаёт размер
/// карты позиций: по нему видно, не прилип ли к ответу узел, которого в графе нет.
std::int32_t sf_layout_place(std::int64_t seed_id,
                             const std::int64_t* nodes,
                             std::int32_t node_count,
                             const std::int64_t* edges,
                             std::int32_t edge_count,
                             const std::int64_t* expanded,
                             std::int32_t expanded_count,
                             const std::int64_t* expand_parent,
                             std::int32_t parent_count,
                             const std::int64_t* pinned_ids,
                             const double* pinned_xy,
                             std::int32_t pinned_count,
                             double node_radius,
                             double node_gap,
                             std::int32_t capacity,
                             std::int64_t* out_ids,
                             double* out_xy,
                             std::int32_t* out_position_count) {
  LayoutRequest request;
  request.seed_id = seed_id;
  request.params = MakeParams(node_radius, node_gap);

  request.nodes.assign(nodes, nodes + node_count);
  request.expanded.assign(expanded, expanded + expanded_count);
  for (std::int32_t i = 0; i < edge_count; ++i) {
    request.edges.emplace_back(edges[2 * i], edges[2 * i + 1]);
  }
  for (std::int32_t i = 0; i < parent_count; ++i) {
    request.expand_parent[expand_parent[2 * i]] = expand_parent[2 * i + 1];
  }
  for (std::int32_t i = 0; i < pinned_count; ++i) {
    request.pinned[pinned_ids[i]] = Point{pinned_xy[2 * i], pinned_xy[2 * i + 1]};
  }

  const six_feat::layout::LayoutResult result = six_feat::layout::PlaceExpandedNodes(request);

  if (out_position_count != nullptr) {
    *out_position_count = static_cast<std::int32_t>(result.positions.size());
  }
  if (static_cast<std::int32_t>(result.order.size()) > capacity) {
    return -1;
  }

  for (std::size_t i = 0; i < result.order.size(); ++i) {
    const std::int64_t id = result.order[i];
    out_ids[i] = id;
    const auto it = result.positions.find(id);
    out_xy[2 * i] = it == result.positions.end() ? 0.0 : it->second.x;
    out_xy[2 * i + 1] = it == result.positions.end() ? 0.0 : it->second.y;
  }
  return static_cast<std::int32_t>(result.order.size());
}

/// Разведение наложившихся узлов: xy правится на месте, возвращается размер карты.
std::int32_t sf_resolve_collisions(const std::int64_t* order,
                                   std::int32_t order_count,
                                   double* xy,
                                   const std::int64_t* pinned_ids,
                                   std::int32_t pinned_count,
                                   const std::int64_t* extra_ids,
                                   const double* extra_xy,
                                   std::int32_t extra_count,
                                   double node_radius,
                                   double node_gap) {
  const std::vector<std::int64_t> order_vec(order, order + order_count);
  const std::vector<std::int64_t> pinned_vec(pinned_ids, pinned_ids + pinned_count);

  std::unordered_map<std::int64_t, Point> targets;
  for (std::int32_t i = 0; i < order_count; ++i) {
    targets[order[i]] = Point{xy[2 * i], xy[2 * i + 1]};
  }

  std::vector<std::pair<std::int64_t, Point>> extra;
  for (std::int32_t i = 0; i < extra_count; ++i) {
    extra.emplace_back(extra_ids[i], Point{extra_xy[2 * i], extra_xy[2 * i + 1]});
  }

  six_feat::layout::ResolveCollisions(order_vec, targets, pinned_vec, extra, nullptr,
                                      MakeParams(node_radius, node_gap));

  for (std::int32_t i = 0; i < order_count; ++i) {
    const auto it = targets.find(order[i]);
    if (it == targets.end()) {
      continue;
    }
    xy[2 * i] = it->second.x;
    xy[2 * i + 1] = it->second.y;
  }
  return static_cast<std::int32_t>(targets.size());
}

}
