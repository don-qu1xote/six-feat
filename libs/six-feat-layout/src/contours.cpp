#include <algorithm>
#include <limits>
#include <six-feat-layout/contours.hpp>

namespace six_feat::layout {

namespace {

double Cross(const Point& o, const Point& a, const Point& b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

std::vector<Point> HalfHull(const std::vector<Point>& sequence) {
  std::vector<Point> hull;
  for (const auto& p : sequence) {
    while (hull.size() >= 2 && Cross(hull[hull.size() - 2], hull[hull.size() - 1], p) <= 0.0) {
      hull.pop_back();
    }
    hull.push_back(p);
  }
  if (!hull.empty()) hull.pop_back();
  return hull;
}

}  // namespace

std::vector<Point> ConvexHull(const std::vector<Point>& points) {
  std::vector<Point> pts = points;
  std::sort(pts.begin(), pts.end(), [](const Point& a, const Point& b) {
    return a.x != b.x ? a.x < b.x : a.y < b.y;
  });
  pts.erase(std::unique(pts.begin(),
                        pts.end(),
                        [](const Point& a, const Point& b) { return a.x == b.x && a.y == b.y; }),
            pts.end());
  if (pts.size() <= 2) return pts;

  const std::vector<Point> lower = HalfHull(pts);
  std::vector<Point> reversed(pts.rbegin(), pts.rend());
  const std::vector<Point> upper = HalfHull(reversed);

  std::vector<Point> hull = lower;
  hull.insert(hull.end(), upper.begin(), upper.end());
  return hull;
}

std::vector<Point> PadHull(const std::vector<Point>& hull, double padding) {
  if (hull.size() < 3) return hull;

  double sum_x = 0.0;
  double sum_y = 0.0;
  for (const auto& p : hull) {
    sum_x += p.x;
    sum_y += p.y;
  }
  const double cx = sum_x / static_cast<double>(hull.size());
  const double cy = sum_y / static_cast<double>(hull.size());

  std::vector<Point> padded;
  padded.reserve(hull.size());
  for (const auto& p : hull) {
    const double dx = p.x - cx;
    const double dy = p.y - cy;
    const double d0 = Hypot(dx, dy);
    const double d = d0 != 0.0 ? d0 : 1.0;
    const double scale = (d + padding) / d;
    padded.push_back(Point{cx + dx * scale, cy + dy * scale});
  }
  return padded;
}

std::vector<Point> ComputeSectorPolygon(const std::vector<Point>& member_positions,
                                        double padding) {
  if (member_positions.size() < 2) return {};

  const std::vector<Point> hull = ConvexHull(member_positions);
  if (hull.size() >= 3) return PadHull(hull, padding);

  double min_x = std::numeric_limits<double>::infinity();
  double max_x = -std::numeric_limits<double>::infinity();
  double min_y = std::numeric_limits<double>::infinity();
  double max_y = -std::numeric_limits<double>::infinity();
  for (const auto& p : member_positions) {
    min_x = std::min(min_x, p.x);
    max_x = std::max(max_x, p.x);
    min_y = std::min(min_y, p.y);
    max_y = std::max(max_y, p.y);
  }
  min_x -= padding;
  max_x += padding;
  min_y -= padding;
  max_y += padding;

  return {Point{min_x, min_y}, Point{max_x, min_y}, Point{max_x, max_y}, Point{min_x, max_y}};
}

std::vector<Contour> BuildContours(
    const std::vector<std::pair<std::int64_t, std::vector<std::int64_t>>>& sectors,
    const std::unordered_map<std::int64_t, Point>& positions,
    double padding) {
  std::vector<Contour> contours;
  for (const auto& [hub, members] : sectors) {
    std::vector<Point> member_positions;
    member_positions.reserve(members.size());
    for (const auto id : members) {
      const auto it = positions.find(id);
      if (it != positions.end()) member_positions.push_back(it->second);
    }
    if (member_positions.size() < 2) continue;

    std::vector<Point> polygon = ComputeSectorPolygon(member_positions, padding);
    if (polygon.size() < 3) continue;
    contours.push_back(Contour{hub, std::move(polygon)});
  }
  return contours;
}

}  // namespace six_feat::layout
