#pragma once

#include <cstdint>
#include <six-feat-layout/geometry.hpp>
#include <unordered_map>
#include <utility>
#include <vector>

namespace six_feat::layout {

/// Выпуклая оболочка (обход Эндрю), точки в том же порядке, что и в браузере.
///
/// Совпадающие точки схлопываются, точки на одной прямой выбрасываются: у
/// прежней реализации был именно такой обход, а контур — вещь видимая, лишняя
/// вершина на прямой сместила бы сглаживание.
std::vector<Point> ConvexHull(const std::vector<Point>& points);

/// Раздувает оболочку от её центроида на padding — контур не липнет к узлам.
std::vector<Point> PadHull(const std::vector<Point>& hull, double padding);

/// Многоугольник вокруг группы: оболочка с отступом, а для вырожденных
/// случаев (меньше трёх вершин — все точки на прямой или их всего две)
/// прямоугольник по габаритам с тем же отступом.
std::vector<Point> ComputeSectorPolygon(const std::vector<Point>& member_positions, double padding);

/// Контуры всех групп. Группы с одним участником и вырожденные многоугольники
/// пропускаются — рисовать там нечего.
std::vector<Contour> BuildContours(
    const std::vector<std::pair<std::int64_t, std::vector<std::int64_t>>>& sectors,
    const std::unordered_map<std::int64_t, Point>& positions,
    double padding);

}  // namespace six_feat::layout
