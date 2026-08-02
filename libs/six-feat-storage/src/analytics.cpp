
#include <algorithm>
#include <deque>
#include <limits>
#include <six-feat-storage/analytics.hpp>
#include <stack>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace six_feat {

static bool IsStarGraph(const AdjList& adj,
                        const std::vector<std::int64_t>& nodes,
                        std::int64_t centre) {
  if (nodes.size() < 2) return false;

  const auto cit = adj.find(centre);
  if (cit == adj.end()) return false;
  if (cit->second.size() != nodes.size() - 1) return false;

  for (const auto id : nodes) {
    if (id == centre) continue;
    const auto it = adj.find(id);
    if (it == adj.end()) return false;
    if (it->second.size() != 1) return false;
    if (it->second[0].neighbour != centre) return false;
  }
  return true;
}

std::unordered_map<std::int64_t, double> BetweennessCentrality(
    const AdjList& adj, const std::vector<std::int64_t>& nodes) {
  std::unordered_map<std::int64_t, double> bc;
  bc.reserve(nodes.size());
  for (const auto id : nodes) bc[id] = 0.0;

  if (nodes.empty()) return bc;

  const std::int64_t first = nodes.front();
  if (IsStarGraph(adj, nodes, first)) {
    const double n = static_cast<double>(nodes.size() - 1);
    bc[first] = n * (n - 1.0) / 2.0;
    bc[first] *= 0.5;
    return bc;
  }

  std::unordered_map<std::int64_t, std::vector<std::int64_t>> predecessors;
  predecessors.reserve(nodes.size());
  std::unordered_map<std::int64_t, double> sigma;
  sigma.reserve(nodes.size());
  std::unordered_map<std::int64_t, int> dist;
  dist.reserve(nodes.size());
  std::unordered_map<std::int64_t, double> delta;
  delta.reserve(nodes.size());
  for (const auto id : nodes) {
    predecessors[id];
    sigma[id] = 0.0;
    dist[id] = -1;
    delta[id] = 0.0;
  }

  std::stack<std::int64_t> order;
  std::deque<std::int64_t> queue;

  for (const auto s : nodes) {
    for (const auto id : nodes) {
      predecessors[id].clear();
      sigma[id] = 0.0;
      dist[id] = -1;
      delta[id] = 0.0;
    }
    sigma[s] = 1.0;
    dist[s] = 0;

    queue.push_back(s);

    while (!queue.empty()) {
      const std::int64_t v = queue.front();
      queue.pop_front();
      order.push(v);

      const auto it = adj.find(v);
      if (it == adj.end()) continue;

      for (const auto& edge : it->second) {
        const std::int64_t w = edge.neighbour;
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue.push_back(w);
        }
        if (dist[w] == dist[v] + 1) {
          sigma[w] += sigma[v];
          predecessors[w].push_back(v);
        }
      }
    }

    while (!order.empty()) {
      const std::int64_t w = order.top();
      order.pop();
      for (const std::int64_t v : predecessors[w]) {
        if (sigma[w] > 0.0) delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w]);
      }
      if (w != s) bc[w] += delta[w];
    }
  }

  for (auto& [id, score] : bc) score *= 0.5;
  return bc;
}

std::vector<std::int64_t> BidirectionalBfs(const AdjList& adj, std::int64_t src, std::int64_t dst) {
  if (src == dst) return {src};
  if (adj.find(src) == adj.end() || adj.find(dst) == adj.end()) return {};

  std::unordered_map<std::int64_t, std::int64_t> pred_fwd, pred_bwd;
  pred_fwd[src] = -1;
  pred_bwd[dst] = -1;

  std::unordered_map<std::int64_t, int> dist_fwd, dist_bwd;
  dist_fwd[src] = 0;
  dist_bwd[dst] = 0;

  std::deque<std::int64_t> q_fwd{src}, q_bwd{dst};

  using Pending = std::pair<std::int64_t, std::int64_t>;
  const auto collect_layer =
      [&](std::deque<std::int64_t>& queue,
          const std::unordered_map<std::int64_t, std::int64_t>& visited) -> std::vector<Pending> {
    std::vector<Pending> pending;
    const std::size_t layer_size = queue.size();
    for (std::size_t i = 0; i < layer_size; ++i) {
      const std::int64_t v = queue.front();
      queue.pop_front();
      const auto adj_it = adj.find(v);
      if (adj_it == adj.end()) continue;
      for (const auto& edge : adj_it->second) {
        const std::int64_t w = edge.neighbour;
        if (!visited.count(w)) {
          pending.push_back({v, w});
        }
      }
    }
    return pending;
  };

  const auto commit = [&](const std::vector<Pending>& pending,
                          std::unordered_map<std::int64_t, std::int64_t>& pred,
                          std::unordered_map<std::int64_t, int>& dist,
                          std::deque<std::int64_t>& queue) -> std::unordered_set<std::int64_t> {
    std::unordered_set<std::int64_t> added;
    for (const auto& [parent, child] : pending) {
      if (pred.count(child)) continue;
      pred[child] = parent;
      dist[child] = dist.at(parent) + 1;
      queue.push_back(child);
      added.insert(child);
    }
    return added;
  };

  const auto reconstruct = [&](std::int64_t m) -> std::vector<std::int64_t> {
    std::vector<std::int64_t> fwd;
    for (std::int64_t cur = m; cur != -1; cur = pred_fwd.at(cur)) fwd.push_back(cur);
    std::reverse(fwd.begin(), fwd.end());

    std::vector<std::int64_t> bwd;
    {
      auto it = pred_bwd.find(m);
      if (it != pred_bwd.end() && it->second != -1) {
        for (std::int64_t cur = it->second; cur != -1; cur = pred_bwd.at(cur)) bwd.push_back(cur);
      }
    }
    fwd.insert(fwd.end(), bwd.begin(), bwd.end());
    return fwd;
  };

  const auto best_meeting =
      [&](const std::unordered_set<std::int64_t>& candidates) -> std::int64_t {
    std::int64_t best = -1;
    int best_len = std::numeric_limits<int>::max();
    for (const auto m : candidates) {
      const auto df = dist_fwd.find(m);
      const auto db = dist_bwd.find(m);
      if (df == dist_fwd.end() || db == dist_bwd.end()) continue;
      const int len = df->second + db->second;
      if (len < best_len) {
        best_len = len;
        best = m;
      }
    }
    return best;
  };

  while (!q_fwd.empty() || !q_bwd.empty()) {
    const bool expand_fwd = q_bwd.empty() || (!q_fwd.empty() && q_fwd.size() <= q_bwd.size());

    if (expand_fwd) {
      auto pending_fwd = collect_layer(q_fwd, pred_fwd);
      auto added_fwd = commit(pending_fwd, pred_fwd, dist_fwd, q_fwd);

      std::unordered_set<std::int64_t> meetings;
      for (const auto id : added_fwd)
        if (pred_bwd.count(id)) meetings.insert(id);

      if (!meetings.empty()) {
        if (!q_bwd.empty()) {
          auto pending_bwd = collect_layer(q_bwd, pred_bwd);
          auto added_bwd = commit(pending_bwd, pred_bwd, dist_bwd, q_bwd);
          for (const auto id : added_bwd)
            if (pred_fwd.count(id)) meetings.insert(id);
        }
        const std::int64_t m = best_meeting(meetings);
        if (m != -1) return reconstruct(m);
      }
    } else {
      auto pending_bwd = collect_layer(q_bwd, pred_bwd);
      auto added_bwd = commit(pending_bwd, pred_bwd, dist_bwd, q_bwd);

      std::unordered_set<std::int64_t> meetings;
      for (const auto id : added_bwd)
        if (pred_fwd.count(id)) meetings.insert(id);

      if (!meetings.empty()) {
        if (!q_fwd.empty()) {
          auto pending_fwd = collect_layer(q_fwd, pred_fwd);
          auto added_fwd = commit(pending_fwd, pred_fwd, dist_fwd, q_fwd);
          for (const auto id : added_fwd)
            if (pred_bwd.count(id)) meetings.insert(id);
        }
        const std::int64_t m = best_meeting(meetings);
        if (m != -1) return reconstruct(m);
      }
    }
  }

  return {};
}

}  // namespace six_feat