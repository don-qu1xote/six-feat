#pragma once

#include <six-feat-core/rate_limit_store.hpp>

#include <userver/storages/postgres/cluster.hpp>

namespace six_feat {

class PostgresRateLimitStore final : public RateLimitStore {
 public:
  explicit PostgresRateLimitStore(userver::storages::postgres::ClusterPtr cluster);

  bool Allow(const std::string& key, int max_per_window, std::chrono::seconds window) override;
  int Remaining(const std::string& key,
                int max_per_window,
                std::chrono::seconds window) const override;

 private:
  userver::storages::postgres::ClusterPtr cluster_;
};

}  // namespace six_feat