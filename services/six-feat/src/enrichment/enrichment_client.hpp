#pragma once

// HTTP-based replacement for the in-process EnrichmentWorker (moved out to
// the standalone six-feat-enrichment service, IDEA-25). CollabService calls
// EnqueueIfNeeded() exactly as it called EnrichmentWorker::EnqueueIfNeeded()
// before; status_handler/sse_status_handler call IsEnriching() to proxy the
// "enriching" flag from GET /internal/status.
//
// Every failure mode (network error, timeout, non-2xx, malformed JSON) is
// caught internally and degrades to false plus a warning log — callers
// never see an exception from this component, matching how the previous
// EnrichmentWorker call sites never wrapped EnqueueIfNeeded in a try/catch.
//
// [IDEA-43] When the outbound POST /internal/enqueue fails (exception or
// non-2xx), the job is not simply dropped: it is kept in a bounded,
// in-memory retry queue and re-sent periodically by a background coroutine
// started in OnAllComponentsLoaded(). This is a best-effort safety net —
// RecoverPendingArtists() on the enrichment side remains the durable
// fallback (re-enqueue there is idempotent, deduped by pending_ and skips
// artists already at Depth::Full), so losing this in-memory queue on
// restart is acceptable.

#include "domain/domain_types.hpp"

#include <chrono>
#include <cstdint>
#include <deque>
#include <string>
#include <string_view>
#include <unordered_map>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/utils/statistics/entry.hpp>
#include <userver/utils/statistics/fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

class EnrichmentClient final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "enrichment-client";

    EnrichmentClient(const userver::components::ComponentConfig&  config,
                      const userver::components::ComponentContext& context);

    ~EnrichmentClient() override;

    // Starts the retry-queue flusher coroutine once every component is
    // fully constructed — must not start it from the constructor.
    void OnAllComponentsLoaded() override;

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // Equivalent of the old EnrichmentWorker::EnqueueIfNeeded. Never throws.
    // On a failed HTTP send, the job is stashed in the retry queue (subject
    // to capacity/dedup) instead of being lost.
    bool EnqueueIfNeeded(const ArtistRef& ref, const std::string& user_token) const;

    // Equivalent of the old EnrichmentWorker::IsPending, backing the
    // "enriching" field on /api/v1/status and /api/v1/status/stream. Never
    // throws; returns false if the enrichment service can't be reached.
    bool IsEnriching(std::int64_t artist_id) const;

private:
    struct RetryJob {
        std::int64_t                                   artist_id{0};
        std::string                                     name;
        std::string                                     image;
        std::string                                     url;
        std::string                                     user_token;
        std::chrono::steady_clock::time_point           created_at;
    };

    struct EnrichingCacheEntry {
        bool                                   enriching{false};
        std::chrono::steady_clock::time_point  fetched_at;
    };

    // Performs the actual GET /internal/status call, bypassing the cache.
    // Never throws; returns false on any exception or non-2xx status.
    bool FetchEnriching(std::int64_t artist_id) const;

    // Bounds enriching_cache_ so it can't grow without limit across many
    // distinct artist_ids: drops the oldest entries once over capacity.
    void PruneEnrichingCacheLocked() const;

    // Performs the actual POST /internal/enqueue call. Never throws;
    // returns false on any exception or non-2xx status.
    bool SendEnqueueRequest(std::int64_t        artist_id,
                             const std::string& name,
                             const std::string& image,
                             const std::string& url,
                             const std::string& user_token) const;

    // Stashes a failed job in the retry queue: no-op if the artist is
    // already queued (dedup); evicts the oldest entry on overflow.
    void EnqueueRetry(const ArtistRef& ref, const std::string& user_token) const;

    // Runs on fs-task-processor: wakes up every retry_interval_, re-sends
    // everything currently in the retry queue, drops entries older than
    // max_retry_age_, and removes whatever was sent successfully.
    void FlushLoop();

    // [IDEA-27] Exposes the retry-queue size on the internal metrics
    // endpoint — see six_feat::EnrichmentWorker::ExtendStatistics for the
    // sibling registration pattern.
    void ExtendStatistics(userver::utils::statistics::Writer& writer) const;

    userver::clients::http::Client& http_client_;
    const std::string               base_url_;
    const std::string               shared_secret_;
    const std::chrono::milliseconds timeout_;

    const std::size_t               retry_queue_capacity_;
    const std::chrono::milliseconds retry_interval_;
    const std::chrono::seconds      max_retry_age_;

    const std::chrono::milliseconds enriching_cache_ttl_;
    static constexpr std::size_t    kEnrichingCacheCapacity = 4096;

    userver::engine::TaskProcessor& fs_tp_;

    mutable userver::engine::Mutex  retry_mu_;
    mutable std::deque<RetryJob>    retry_queue_;

    mutable userver::engine::Mutex                                    enriching_cache_mu_;
    mutable std::unordered_map<std::int64_t, EnrichingCacheEntry>      enriching_cache_;

    userver::engine::TaskWithResult<void> flush_task_;

    userver::utils::statistics::Entry statistics_holder_;
};

} // namespace six_feat
