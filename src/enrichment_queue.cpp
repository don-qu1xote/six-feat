// ════════════════════════════════════════════════════════════════════════════
// enrichment_queue.cpp  —  iteration 6
// ════════════════════════════════════════════════════════════════════════════

#include "enrichment_queue.hpp"

#include <userver/logging/log.hpp>

namespace six_feat {

using namespace userver;

bool EnrichmentQueue::TryPush(EnrichmentJob job) {
    std::unique_lock lock(mu_);
    if (closed_ || queue_.size() >= capacity_) return false;
    queue_.push_back(std::move(job));
    lock.unlock();
    cv_not_empty_.NotifyOne();
    return true;
}

std::optional<EnrichmentJob> EnrichmentQueue::BlockingPop() {
    std::unique_lock lock(mu_);
    // Capture [[nodiscard]] return value
    [[maybe_unused]] const bool notified = cv_not_empty_.Wait(lock, [this] {
        return !queue_.empty() || closed_;
    });
    
    if (queue_.empty()) return std::nullopt;
    EnrichmentJob job = std::move(queue_.front());
    queue_.pop_front();
    return job;
}

void EnrichmentQueue::Close() {
    std::unique_lock lock(mu_);
    closed_ = true;
    lock.unlock();
    cv_not_empty_.NotifyAll();
    LOG_INFO() << "[EnrichmentQueue] closed";
}

std::size_t EnrichmentQueue::Size() const {
    std::unique_lock lock(mu_);
    return queue_.size();
}

bool EnrichmentQueue::IsClosed() const {
    std::unique_lock lock(mu_);
    return closed_;
}

} // namespace six_feat
