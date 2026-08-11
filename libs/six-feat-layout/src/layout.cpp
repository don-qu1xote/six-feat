#include <algorithm>
#include <cmath>
#include <six-feat-layout/contours.hpp>
#include <six-feat-layout/layout.hpp>
#include <string>
#include <unordered_set>

namespace six_feat::layout {

namespace {

constexpr double kPi = 3.14159265358979323846;

constexpr double kLeafR = 150.0;
constexpr double kLeafGap = 58.0;
constexpr double kGoldenAngle = 2.399963229728653;
constexpr int kSolverIters = 8;
constexpr double kSolverEps = 0.01;
constexpr double kRingCapMargin = 1.08;
constexpr double kAngularGap = 0.02;

double Clamp(double v, double lo, double hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

double NormAngle(double a) {
  double x = a;
  while (x <= -kPi) x += 2.0 * kPi;
  while (x > kPi) x -= 2.0 * kPi;
  return x;
}

double FallbackAngle(double seed) {
  return NormAngle(seed * kGoldenAngle);
}

double AngularSep(double a, double b) {
  return std::fabs(NormAngle(a - b));
}

int RingCap(double r, double node_w) {
  const double target = node_w * kRingCapMargin;
  const double ratio = target / (2.0 * r);
  if (ratio >= 1.0) return 1;
  return std::max(1, static_cast<int>(std::floor(kPi / std::asin(ratio))));
}

double AdaptiveRingGap(std::size_t n, double node_w) {
  const double gap = kLeafGap * (1.0 + std::log2(1.0 + static_cast<double>(n) / 12.0) * 0.15);
  return std::max(node_w, gap);
}

double DandelionR(std::size_t n, double node_w) {
  if (n == 0) return kLeafR * 0.5;
  const double gap = AdaptiveRingGap(n, node_w);
  double rem = static_cast<double>(n);
  int k = 0;
  while (rem > 0) {
    rem -= RingCap(kLeafR + k * gap, node_w);
    k++;
    if (k > 60) break;
  }
  return kLeafR + (k - 1) * gap + node_w * 0.5;
}

template <typename V>
struct OrderedMap {
  std::vector<std::int64_t> order;
  std::unordered_map<std::int64_t, V> values;

  bool Has(std::int64_t key) const {
    return values.find(key) != values.end();
  }

  V& operator[](std::int64_t key) {
    auto it = values.find(key);
    if (it == values.end()) {
      order.push_back(key);
      return values.emplace(key, V{}).first->second;
    }
    return it->second;
  }

  const V* Find(std::int64_t key) const {
    const auto it = values.find(key);
    return it == values.end() ? nullptr : &it->second;
  }

  void Set(std::int64_t key, V value) {
    auto it = values.find(key);
    if (it == values.end()) {
      order.push_back(key);
      values.emplace(key, std::move(value));
    } else {
      it->second = std::move(value);
    }
  }
};

struct OrderedSet {
  std::vector<std::int64_t> order;
  std::unordered_set<std::int64_t> items;

  bool Has(std::int64_t v) const {
    return items.find(v) != items.end();
  }
  void Add(std::int64_t v) {
    if (items.insert(v).second) order.push_back(v);
  }
  std::size_t Size() const {
    return order.size();
  }
};

struct PoleState {
  double x{0.0};
  double y{0.0};
  double d_r{0.0};
};

struct Footprint {
  double angle{0.0};
  double half{0.0};
};

}  // namespace

void ResolveCollisions(const std::vector<std::int64_t>& order,
                       std::unordered_map<std::int64_t, Point>& targets,
                       const std::vector<std::int64_t>& pinned_ids,
                       const std::vector<std::pair<std::int64_t, Point>>& extra_pinned,
                       const std::unordered_map<std::int64_t, std::vector<std::int64_t>>* sector_of,
                       const LayoutParams& params) {
  const double min_sep = params.MinSep();
  const double cluster_gap = params.ClusterGap();

  const std::unordered_set<std::int64_t> pinned_set(pinned_ids.begin(), pinned_ids.end());

  std::vector<std::int64_t> ids;
  std::vector<double> px, py;
  std::vector<char> pin;
  ids.reserve(order.size() + extra_pinned.size());
  for (const auto id : order) {
    const auto it = targets.find(id);
    if (it == targets.end()) continue;
    ids.push_back(id);
    px.push_back(it->second.x);
    py.push_back(it->second.y);
    pin.push_back(pinned_set.count(id) ? 1 : 0);
  }
  const std::size_t emit_count = ids.size();
  for (const auto& [id, p] : extra_pinned) {
    ids.push_back(id);
    px.push_back(p.x);
    py.push_back(p.y);
    pin.push_back(1);
  }

  const std::size_t n = px.size();
  if (n < 2) return;

  std::vector<const std::vector<std::int64_t>*> sectors;
  if (sector_of != nullptr) {
    sectors.reserve(n);
    for (const auto id : ids) {
      const auto it = sector_of->find(id);
      sectors.push_back(it == sector_of->end() ? nullptr : &it->second);
    }
  }

  const auto disjoint = [](const std::vector<std::int64_t>* a, const std::vector<std::int64_t>* b) {
    if (a == nullptr || b == nullptr || a->empty() || b->empty()) return false;
    for (const auto s : *a) {
      if (std::find(b->begin(), b->end(), s) != b->end()) return false;
    }
    return true;
  };

  const double max_sep = sector_of != nullptr ? min_sep + cluster_gap : min_sep;
  const double min2 = min_sep * min_sep;
  const double inv = 1.0 / max_sep;

  const int iters = sector_of != nullptr ? kSolverIters * 3 : kSolverIters;
  for (int iter = 0; iter < iters; ++iter) {
    std::unordered_map<std::string, std::vector<std::size_t>> grid;
    grid.reserve(n * 2);
    for (std::size_t i = 0; i < n; ++i) {
      const std::string key = std::to_string(static_cast<long long>(std::floor(px[i] * inv))) +
                              ":" + std::to_string(static_cast<long long>(std::floor(py[i] * inv)));
      grid[key].push_back(i);
    }

    bool moved = false;
    for (std::size_t i = 0; i < n; ++i) {
      const long long cx = static_cast<long long>(std::floor(px[i] * inv));
      const long long cy = static_cast<long long>(std::floor(py[i] * inv));
      for (long long gx = cx - 1; gx <= cx + 1; ++gx) {
        for (long long gy = cy - 1; gy <= cy + 1; ++gy) {
          const auto cell_it = grid.find(std::to_string(gx) + ":" + std::to_string(gy));
          if (cell_it == grid.end()) continue;
          for (const auto j : cell_it->second) {
            if (j <= i) continue;
            if (pin[i] && pin[j]) continue;
            const double sep = (!sectors.empty() && disjoint(sectors[i], sectors[j]))
                                   ? min_sep + cluster_gap
                                   : min_sep;
            const double sep2 = sep == min_sep ? min2 : sep * sep;
            double dx = px[j] - px[i];
            double dy = py[j] - py[i];
            const double d2 = dx * dx + dy * dy;
            if (d2 >= sep2) continue;
            double d = std::sqrt(d2);
            if (d < 1e-9) {
              const double a = static_cast<double>(i) * 12.9898 + static_cast<double>(j) * 78.233;
              dx = std::cos(a);
              dy = std::sin(a);
              d = 1.0;
            } else {
              dx /= d;
              dy /= d;
            }
            const double pen = sep - d + kSolverEps;
            moved = true;
            if (pin[i]) {
              px[j] += dx * pen;
              py[j] += dy * pen;
            } else if (pin[j]) {
              px[i] -= dx * pen;
              py[i] -= dy * pen;
            } else {
              const double h = pen * 0.5;
              px[i] -= dx * h;
              py[i] -= dy * h;
              px[j] += dx * h;
              py[j] += dy * h;
            }
          }
        }
      }
    }
    if (!moved) break;
  }

  for (std::size_t i = 0; i < emit_count; ++i) {
    if (!pin[i]) targets[ids[i]] = Point{px[i], py[i]};
  }
}

LayoutResult PlaceExpandedNodes(const LayoutRequest& request) {
  LayoutResult result;

  const double node_w = request.params.MinSep();
  const double min_sep = node_w;
  const double cluster_gap_floor = min_sep * 2.0;
  const double shared_gap_step = min_sep * 0.6;
  const double shared_gap_max = min_sep * 4.0;

  const std::int64_t seed_id = request.seed_id;

  OrderedSet expanded_set;
  for (const auto id : request.expanded) expanded_set.Add(id);

  std::vector<std::int64_t> poles;
  for (const auto id : expanded_set.order) {
    if (id != seed_id) poles.push_back(id);
  }
  const std::unordered_set<std::int64_t> pole_set(poles.begin(), poles.end());

  const auto saved = [&request](std::int64_t id) -> const Point* {
    const auto it = request.pinned.find(id);
    return it == request.pinned.end() ? nullptr : &it->second;
  };

  OrderedMap<OrderedSet> leaf_owners;
  for (const auto& [a, b] : request.edges) {
    const bool a_is_pole = expanded_set.Has(a) && a != seed_id;
    const bool b_is_pole = expanded_set.Has(b) && b != seed_id;
    const bool a_is_owner = a_is_pole || a == seed_id;
    const bool b_is_owner = b_is_pole || b == seed_id;

    if (a_is_owner && !expanded_set.Has(b) && b != seed_id) leaf_owners[b].Add(a);
    if (b_is_owner && !expanded_set.Has(a) && a != seed_id) leaf_owners[a].Add(b);
  }

  OrderedMap<std::vector<std::int64_t>> exclusive;
  for (const auto id : poles) exclusive[id];

  struct SharedLeaf {
    std::int64_t leaf{0};
    std::vector<std::int64_t> owners;
  };
  std::vector<SharedLeaf> shared_leaves;
  std::unordered_set<std::int64_t> handled_leaves;

  for (const auto leaf : leaf_owners.order) {
    const auto& owners = leaf_owners.values.at(leaf);
    if (owners.Size() == 1) {
      const std::int64_t owner = owners.order.front();
      if (owner == seed_id) continue;
      if (exclusive.Has(owner)) {
        exclusive[owner].push_back(leaf);
        handled_leaves.insert(leaf);
      }
    } else {
      shared_leaves.push_back(SharedLeaf{leaf, owners.order});
      handled_leaves.insert(leaf);
    }
  }

  std::unordered_map<std::string, int> shared_count_cache;
  for (const auto& sl : shared_leaves) {
    auto os = sl.owners;
    std::sort(os.begin(), os.end());
    for (std::size_t i = 0; i < os.size(); ++i) {
      for (std::size_t j = i + 1; j < os.size(); ++j) {
        shared_count_cache[std::to_string(os[i]) + "_" + std::to_string(os[j])] += 1;
      }
    }
  }
  const auto shared_count_between = [&shared_count_cache](std::int64_t a, std::int64_t b) {
    const auto key = std::to_string(std::min(a, b)) + "_" + std::to_string(std::max(a, b));
    const auto it = shared_count_cache.find(key);
    return it == shared_count_cache.end() ? 0 : it->second;
  };

  const auto cluster_gap_for = [&](int shared_count) {
    const double shared_extra =
        std::min(std::sqrt(static_cast<double>(std::max(0, shared_count))) * shared_gap_step,
                 shared_gap_max);
    return cluster_gap_floor + shared_extra;
  };

  std::vector<std::int64_t> seed_leaves;
  for (const auto id : request.nodes) {
    if (expanded_set.Has(id) || id == seed_id || handled_leaves.count(id)) continue;
    seed_leaves.push_back(id);
  }
  const double d_r_seed = DandelionR(seed_leaves.size(), node_w);

  std::unordered_map<std::int64_t, std::int64_t> pole_parent;
  for (const auto id : poles) {
    const auto it = request.expand_parent.find(id);
    std::int64_t parent = it == request.expand_parent.end() ? seed_id : it->second;
    if (parent != seed_id && !pole_set.count(parent)) parent = seed_id;
    if (parent == id) parent = seed_id;
    pole_parent[id] = parent;
  }
  for (const auto id : poles) {
    std::int64_t cur = id;
    std::size_t steps = 0;
    std::unordered_set<std::int64_t> seen;
    while (pole_parent[cur] != seed_id) {
      if (seen.count(cur) || steps++ > poles.size()) {
        pole_parent[id] = seed_id;
        break;
      }
      seen.insert(cur);
      cur = pole_parent[cur];
    }
  }

  std::vector<std::int64_t> root_pole_ids;
  for (const auto id : poles) {
    if (pole_parent[id] == seed_id) root_pole_ids.push_back(id);
  }

  OrderedMap<OrderedSet> pole_neighbors;
  {
    const auto is_hub = [&](std::int64_t id) { return id == seed_id || pole_set.count(id) > 0; };
    for (const auto& [a, b] : request.edges) {
      if (a == b || !is_hub(a) || !is_hub(b)) continue;
      pole_neighbors[a].Add(b);
      pole_neighbors[b].Add(a);
    }
  }

  std::unordered_map<std::int64_t, double> pole_d_r;
  for (const auto id : poles) pole_d_r[id] = DandelionR(exclusive[id].size(), node_w);

  OrderedMap<std::vector<std::int64_t>> pole_children;
  for (const auto id : poles) {
    const auto p = pole_parent[id];
    if (p != seed_id) pole_children[p].push_back(id);
  }

  std::unordered_map<std::int64_t, int> max_sibling_shared;
  {
    std::vector<const std::vector<std::int64_t>*> groups{&root_pole_ids};
    for (const auto key : pole_children.order) groups.push_back(&pole_children.values.at(key));
    for (const auto* group : groups) {
      for (const auto id : *group) {
        int m = 0;
        for (const auto other : *group) {
          if (other != id) m = std::max(m, shared_count_between(id, other));
        }
        max_sibling_shared[id] = m;
      }
    }
  }

  std::unordered_map<std::int64_t, PoleState> placed_poles;
  placed_poles[seed_id] = PoleState{0.0, 0.0, d_r_seed};

  OrderedMap<Point> targets;

  const auto footprint_half = [](double d_r, double gap, double r) {
    if (r < 1e-6) return kPi;
    return std::min(kPi - 1e-3, std::asin(Clamp((d_r + gap / 2.0) / r, -1.0, 1.0)) + kAngularGap);
  };

  const auto overlap_amount = [](double angle, double half, const std::vector<Footprint>& placed) {
    double worst = 0.0;
    for (const auto& s : placed) {
      const double need = half + s.half;
      const double have = AngularSep(angle, s.angle);
      if (need - have > worst) worst = need - have;
    }
    return worst;
  };

  const auto owner_vector = [&](std::int64_t id) -> std::pair<bool, double> {
    const auto* neighbors = pole_neighbors.Find(id);
    if (neighbors == nullptr) return {false, 0.0};
    double sx = 0.0, sy = 0.0;
    int n = 0;
    for (const auto nb : neighbors->order) {
      const auto it = placed_poles.find(nb);
      if (it == placed_poles.end()) continue;
      sx += it->second.x;
      sy += it->second.y;
      n++;
    }
    if (n == 0) return {false, 0.0};
    const double mag = Hypot(sx, sy);
    if (mag < 1e-6) return {false, 0.0};
    return {true, std::atan2(sy, sx)};
  };

  const auto ideal_dist_from_hub = [&](std::int64_t hub_id, double d_r, double gap) {
    const double hub_r = hub_id == seed_id ? d_r_seed : pole_d_r.at(hub_id);
    return hub_r + gap + d_r;
  };

  const auto circle_intersections = [](Point p1, double r1, Point p2, double r2) {
    std::vector<Point> out;
    const double dx = p2.x - p1.x, dy = p2.y - p1.y;
    const double d = Hypot(dx, dy);
    if (d < 1e-6 || d > r1 + r2 || d < std::fabs(r1 - r2)) return out;
    const double a = (r1 * r1 - r2 * r2 + d * d) / (2.0 * d);
    const double h_sq = r1 * r1 - a * a;
    const double h = h_sq > 0 ? std::sqrt(h_sq) : 0.0;
    const double mx = p1.x + (a * dx) / d, my = p1.y + (a * dy) / d;
    if (h < 1e-6) {
      out.push_back(Point{mx, my});
      return out;
    }
    const double ox = (-dy / d) * h, oy = (dx / d) * h;
    out.push_back(Point{mx + ox, my + oy});
    out.push_back(Point{mx - ox, my - oy});
    return out;
  };

  struct PlacedHub {
    std::int64_t id{0};
    Point pos;
    double r{0.0};
  };

  const auto trilateration_point =
      [&](std::int64_t id, double d_r, double gap) -> std::pair<bool, Point> {
    const auto* neighbors = pole_neighbors.Find(id);
    if (neighbors == nullptr) return {false, Point{}};
    std::vector<PlacedHub> placed;
    for (const auto nb : neighbors->order) {
      const auto it = placed_poles.find(nb);
      if (it == placed_poles.end()) continue;
      placed.push_back(
          PlacedHub{nb, Point{it->second.x, it->second.y}, ideal_dist_from_hub(nb, d_r, gap)});
    }
    if (placed.size() < 2) return {false, Point{}};

    const std::int64_t tree_parent = pole_parent.at(id);

    std::stable_sort(placed.begin(), placed.end(), [tree_parent](const auto& a, const auto& b) {
      const int ka = a.id == tree_parent ? -1 : 0;
      const int kb = b.id == tree_parent ? -1 : 0;
      return ka < kb;
    });

    const double fallback_angle = FallbackAngle(static_cast<double>(id));
    const auto outward_angle = [&](const PlacedHub& hub) {
      const double d = Hypot(hub.pos.x, hub.pos.y);
      return d > 1e-6 ? std::atan2(hub.pos.y, hub.pos.x) : fallback_angle;
    };

    const PlacedHub& h1 = placed[0];
    const PlacedHub& h2 = placed[1];

    double wx = 0.0, wy = 0.0;
    for (const auto& hub : placed) {
      const double a = outward_angle(hub);
      const double w = 1.0 / std::max(hub.r, 1e-6);
      wx += std::cos(a) * w;
      wy += std::sin(a) * w;
    }
    const double w_mag = Hypot(wx, wy);
    const double blend_angle = w_mag >= 1e-6 ? std::atan2(wy, wx) : fallback_angle;

    const auto points = circle_intersections(h1.pos, h1.r, h2.pos, h2.r);
    if (!points.empty()) {
      const double ref_x = h1.pos.x + h1.r * std::cos(blend_angle);
      const double ref_y = h1.pos.y + h1.r * std::sin(blend_angle);
      Point best = points[0];
      double best_dist = Hypot(points[0].x - ref_x, points[0].y - ref_y);
      for (std::size_t i = 1; i < points.size(); ++i) {
        const double d = Hypot(points[i].x - ref_x, points[i].y - ref_y);
        if (d < best_dist) {
          best = points[i];
          best_dist = d;
        }
      }
      return {true, best};
    }

    const PlacedHub& anchor = Hypot(h1.pos.x, h1.pos.y) > 1e-6 ? h1 : h2;
    const double anchor_angle = outward_angle(anchor);
    const double pure_x = anchor.pos.x + anchor.r * std::cos(anchor_angle);
    const double pure_y = anchor.pos.y + anchor.r * std::sin(anchor_angle);
    const double blend_x = anchor.pos.x + anchor.r * std::cos(blend_angle);
    const double blend_y = anchor.pos.y + anchor.r * std::sin(blend_angle);

    const double dx = blend_x - pure_x, dy = blend_y - pure_y;
    const double lateral = Hypot(dx, dy);
    const double max_lateral = min_sep * 6.0;
    if (lateral <= max_lateral || lateral < 1e-6) return {true, Point{blend_x, blend_y}};
    const double scale = max_lateral / lateral;
    return {true, Point{pure_x + dx * scale, pure_y + dy * scale}};
  };

  std::unordered_map<std::int64_t, double> placed_r_all;
  const auto place_children = [&](auto&& self,
                                  std::int64_t parent_id,
                                  const std::vector<std::int64_t>& child_ids,
                                  double parent_r) -> void {
    if (child_ids.empty()) return;
    std::vector<std::int64_t> sorted = child_ids;
    std::sort(sorted.begin(), sorted.end());

    std::vector<std::int64_t> pinned_children, fresh;
    for (const auto id : sorted) {
      (saved(id) != nullptr ? pinned_children : fresh).push_back(id);
    }

    std::vector<Footprint> placed_this_round;
    std::unordered_map<std::int64_t, double> placed_r;

    for (const auto id : pinned_children) {
      const Point p = *saved(id);
      const double d_r = pole_d_r.at(id);
      const double r = std::max(Hypot(p.x, p.y), 1e-6);
      placed_poles[id] = PoleState{p.x, p.y, d_r};
      targets.Set(id, p);
      const int shared_count =
          std::max(shared_count_between(id, parent_id), max_sibling_shared[id]);
      const double gap = cluster_gap_for(shared_count);
      placed_this_round.push_back(Footprint{std::atan2(p.y, p.x), footprint_half(d_r, gap, r)});
      placed_r[id] = r;
    }

    for (const auto id : fresh) {
      const double d_r = pole_d_r.at(id);
      const int shared_count =
          std::max(shared_count_between(id, parent_id), max_sibling_shared[id]);
      const double gap = cluster_gap_for(shared_count);
      const bool is_root = parent_id == seed_id;

      const auto tri = trilateration_point(id, d_r, gap);
      double base_r = 0.0, attempt_angle = 0.0;
      if (tri.first) {
        base_r = Hypot(tri.second.x, tri.second.y);
        attempt_angle = std::atan2(tri.second.y, tri.second.x);
      } else {
        base_r = is_root ? d_r_seed + d_r + gap : parent_r + pole_d_r.at(parent_id) + d_r + gap;
        const auto ov = owner_vector(id);
        attempt_angle = ov.first ? ov.second : FallbackAngle(static_cast<double>(id));
      }

      double r = base_r;
      double angle = attempt_angle;
      double half = footprint_half(d_r, gap, r);
      const auto fits = [&](double a, double h) {
        for (const auto& s : placed_this_round) {
          if (AngularSep(a, s.angle) < h + s.half) return false;
        }
        return true;
      };
      bool ok = fits(angle, half);

      double best_angle = angle;
      double best_overlap = overlap_amount(angle, half, placed_this_round);

      int tries = 0;
      while (!ok && tries < 24) {
        tries++;
        const int k = (tries + 1) / 2;
        const double sign = tries % 2 == 1 ? 1.0 : -1.0;
        angle = NormAngle(attempt_angle + sign * k * (half + kAngularGap) * 1.3);
        ok = fits(angle, half);
        const double overlap = overlap_amount(angle, half, placed_this_round);
        if (overlap < best_overlap) {
          best_overlap = overlap;
          best_angle = angle;
        }
      }
      if (!ok) {
        angle = best_angle;
        half = footprint_half(d_r, gap, r);
        ok = fits(angle, half);
        const double grow_step = std::max(gap, d_r);
        for (int grow = 0; grow < 5 && !ok; ++grow) {
          r += grow_step;
          half = footprint_half(d_r, gap, r);
          ok = fits(angle, half);
        }
      }

      const double x = std::cos(angle) * r, y = std::sin(angle) * r;
      placed_poles[id] = PoleState{x, y, d_r};
      targets.Set(id, Point{x, y});
      placed_this_round.push_back(Footprint{angle, half});
      placed_r[id] = r;
    }

    for (const auto id : sorted) {
      placed_r_all[id] = placed_r[id];
      const auto* children = pole_children.Find(id);
      self(self, id, children == nullptr ? std::vector<std::int64_t>{} : *children, placed_r[id]);
    }
  };
  place_children(place_children, seed_id, root_pole_ids, 0.0);

  for (const auto pole_id : exclusive.order) {
    const auto& leaves = exclusive.values.at(pole_id);
    if (leaves.empty()) continue;
    const auto& p = placed_poles.at(pole_id);
    const double base_angle = std::atan2(p.y, p.x);
    const double gap = AdaptiveRingGap(leaves.size(), node_w);
    std::size_t consumed = 0;
    int k = 0;
    while (consumed < leaves.size()) {
      const double r = kLeafR + k * gap;
      const std::size_t cap = static_cast<std::size_t>(RingCap(r, node_w));
      const std::size_t take = std::min(cap, leaves.size() - consumed);
      for (std::size_t i = 0; i < take; ++i) {
        const double ang =
            base_angle + (2.0 * kPi * static_cast<double>(i)) / static_cast<double>(take);
        targets.Set(leaves[consumed + i], Point{p.x + std::cos(ang) * r, p.y + std::sin(ang) * r});
      }
      consumed += take;
      k++;
    }
  }

  struct Zone {
    std::vector<std::int64_t> owners;
    std::vector<std::int64_t> leaves;
  };
  std::vector<std::string> zone_order;
  std::unordered_map<std::string, Zone> zones;
  for (const auto& sl : shared_leaves) {
    std::vector<std::string> parts;
    parts.reserve(sl.owners.size());
    for (const auto o : sl.owners) parts.push_back(std::to_string(o));
    std::sort(parts.begin(), parts.end());
    std::string key;
    for (std::size_t i = 0; i < parts.size(); ++i) {
      if (i) key += "_";
      key += parts[i];
    }
    auto it = zones.find(key);
    if (it == zones.end()) {
      zone_order.push_back(key);
      it = zones.emplace(key, Zone{sl.owners, {}}).first;
    }
    it->second.leaves.push_back(sl.leaf);
  }

  for (const auto& key : zone_order) {
    const auto& zone = zones.at(key);
    std::vector<std::int64_t> valid;
    for (const auto o : zone.owners) {
      if (placed_poles.count(o)) valid.push_back(o);
    }
    if (valid.empty()) continue;

    const double min_r_from_seed =
        d_r_seed + cluster_gap_for(static_cast<int>(zone.leaves.size())) * 0.5;

    double cx = 0.0, cy = 0.0;
    for (const auto o : valid) {
      cx += placed_poles.at(o).x;
      cy += placed_poles.at(o).y;
    }
    cx /= static_cast<double>(valid.size());
    cy /= static_cast<double>(valid.size());

    const double r_from_seed = Hypot(cx, cy);
    if (r_from_seed < min_r_from_seed) {
      double sum = 0.0;
      for (const auto o : valid) sum += static_cast<double>(o);
      const double push_ang = r_from_seed > 1e-6 ? std::atan2(cy, cx) : FallbackAngle(sum + 1.0);
      cx = std::cos(push_ang) * min_r_from_seed;
      cy = std::sin(push_ang) * min_r_from_seed;
    }

    const auto& leaves = zone.leaves;
    if (leaves.empty()) continue;
    if (leaves.size() == 1) {
      targets.Set(leaves[0], Point{cx, cy});
      continue;
    }
    const double gap = AdaptiveRingGap(leaves.size(), node_w);
    const double r0 = std::max(node_w * 0.55, gap * 0.5);
    std::size_t consumed = 0;
    int k = 0;
    while (consumed < leaves.size()) {
      const double r = r0 + k * gap;
      const std::size_t cap = static_cast<std::size_t>(RingCap(r, node_w));
      const std::size_t take = std::min(cap, leaves.size() - consumed);
      const double rotate = k * kGoldenAngle;
      for (std::size_t i = 0; i < take; ++i) {
        const double ang =
            rotate + (2.0 * kPi * static_cast<double>(i)) / static_cast<double>(take);
        targets.Set(leaves[consumed + i], Point{cx + std::cos(ang) * r, cy + std::sin(ang) * r});
      }
      consumed += take;
      k++;
    }
  }

  OrderedMap<OrderedSet> sector_members;
  for (const auto id : poles) {
    sector_members[id].Add(id);
    for (const auto leaf : exclusive.values.at(id)) sector_members[id].Add(leaf);
  }
  sector_members[seed_id].Add(seed_id);
  for (const auto leaf : seed_leaves) sector_members[seed_id].Add(leaf);
  for (const auto& key : zone_order) {
    const auto& zone = zones.at(key);
    for (const auto owner : zone.owners) {
      if (!sector_members.Has(owner)) continue;
      for (const auto leaf : zone.leaves) sector_members[owner].Add(leaf);
    }
  }

  if (!seed_leaves.empty()) {
    std::vector<std::int64_t> fresh_seed_leaves;
    for (const auto id : seed_leaves) {
      if (const auto* p = saved(id)) {
        targets.Set(id, *p);
      } else {
        fresh_seed_leaves.push_back(id);
      }
    }

    const double gap = AdaptiveRingGap(seed_leaves.size(), node_w);
    std::size_t consumed = 0;
    int k = 0;
    while (consumed < fresh_seed_leaves.size()) {
      const double r = kLeafR + k * gap;
      const std::size_t cap = static_cast<std::size_t>(RingCap(r, node_w));
      const std::size_t take = std::min(cap, fresh_seed_leaves.size() - consumed);
      for (std::size_t i = 0; i < take; ++i) {
        const double ang = (2.0 * kPi * static_cast<double>(i)) / static_cast<double>(take);
        targets.Set(fresh_seed_leaves[consumed + i], Point{std::cos(ang) * r, std::sin(ang) * r});
      }
      consumed += take;
      k++;
    }
  }

  std::unordered_map<std::int64_t, std::vector<std::int64_t>> sectors_by_node;
  for (const auto sector_id : sector_members.order) {
    for (const auto member_id : sector_members.values.at(sector_id).order) {
      sectors_by_node[member_id].push_back(sector_id);
    }
  }

  ResolveCollisions(targets.order,
                    targets.values,
                    poles,
                    {{seed_id, Point{0.0, 0.0}}},
                    &sectors_by_node,
                    request.params);

  result.order = targets.order;
  result.positions = targets.values;

  std::unordered_map<std::int64_t, Point> drawn = targets.values;
  drawn[seed_id] = Point{0.0, 0.0};
  std::vector<std::pair<std::int64_t, std::vector<std::int64_t>>> sectors;
  sectors.reserve(sector_members.order.size());
  for (const auto sector_id : sector_members.order) {
    sectors.emplace_back(sector_id, sector_members.values.at(sector_id).order);
  }
  result.contours = BuildContours(sectors, drawn, request.params.node_gap);
  return result;
}

}  // namespace six_feat::layout
