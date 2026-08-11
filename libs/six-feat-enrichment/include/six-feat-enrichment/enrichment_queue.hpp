#pragma once

#include <cstddef>
#include <deque>
#include <optional>
#include <six-feat-domain/domain_types.hpp>
#include <userver/engine/condition_variable.hpp>
#include <userver/engine/mutex.hpp>

namespace six_feat {

class EnrichmentQueue final {
 public:
  explicit EnrichmentQueue(std::size_t capacity) : capacity_(capacity) {}

  bool TryPush(EnrichmentJob job);

  std::optional<EnrichmentJob> BlockingPop();

  void Close();

  std::size_t Size() const;
  bool IsClosed() const;

 private:
  const std::size_t capacity_;
  std::deque<EnrichmentJob> queue_;
  bool closed_{false};

  mutable userver::engine::Mutex mu_;
  userver::engine::ConditionVariable cv_not_empty_;
};

}  // namespace six_feat