#pragma once

// ════════════════════════════════════════════════════════════════════════════
// artist_repository.hpp  —  iteration 6
//
// ArtistRepository is the single point of access for artist/song data.
// It orchestrates the two-level cache:
//
//   L2 (LRU, in-memory) — hot nodes for the current session
//   L1 (PersistentStore) — durable source of truth
//
// Read contract (GetArtistSongs):
//   1. L2 hit with depth ≥ want → return immediately (zero I/O).
//   2. L1 hit with depth ≥ want → warm L2, return (no network).
//   3. L1 partial / miss → signal caller with network_needed = true;
//      caller (CollabService / EnrichmentWorker) fetches via GeniusGateway
//      and calls WriteThrough to persist and warm caches.
//
// Write contract (WriteThrough):
//   L1 first (durable), then L2 (warm, optional).  L1 is always the source
//   of truth; L2 is only a fast lookup hint for the hot session.
//
// ArtistRepository is a shared userver component (const read methods,
// WriteThrough is mutable).  The LRU uses std::mutex (no suspend under lock).
//
// Neighbours (LoadNeighbours):
//   Direct delegation to PersistentStore.LoadNeighbours — this is used by
//   CollabService::FindPath to expand the BFS frontier from L1 without
//   loading entire ArtistSongs objects into memory.
// ════════════════════════════════════════════════════════════════════════════

#include "analytics.hpp"      // CollabEdge, AdjList
#include "domain_types.hpp"
#include "persistent_store.hpp"

#include <cstdint>
#include <chrono>
#include <list>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

// ── LruCache (moved here from genius_client.hpp; unchanged implementation) ──

template <typename K, typename V>
class LruCache {
public:
    using Clock    = std::chrono::steady_clock;
    using Duration = std::chrono::seconds;

    explicit LruCache(std::size_t max_size, Duration ttl)
        : max_size_(max_size), ttl_(ttl) {}

    // Get fresh entry (respects TTL).
    std::optional<std::pair<V, Depth>> Get(const K& key) const {
        std::lock_guard lock(mu_);
        auto it = index_.find(key);
        if (it == index_.end()) return std::nullopt;
        if (IsExpired(it->second->expires_at)) return std::nullopt;
        list_.splice(list_.begin(), list_, it->second);
        return std::make_pair(it->second->value, it->second->depth);
    }

    // Get including stale (for CB fallback).
    std::optional<std::pair<V, Depth>> GetStale(const K& key) const {
        std::lock_guard lock(mu_);
        auto it = index_.find(key);
        if (it == index_.end()) return std::nullopt;
        list_.splice(list_.begin(), list_, it->second);
        return std::make_pair(it->second->value, it->second->depth);
    }

    void Put(const K& key, V value, Depth depth) {
        std::lock_guard lock(mu_);
        auto it = index_.find(key);
        if (it != index_.end()) {
            // Monotonically advance depth.
            if (depth < it->second->depth) depth = it->second->depth;
            it->second->value      = std::move(value);
            it->second->depth      = depth;
            it->second->expires_at = Clock::now() + ttl_;
            list_.splice(list_.begin(), list_, it->second);
            return;
        }
        if (list_.size() >= max_size_) {
            index_.erase(list_.back().key);
            list_.pop_back();
        }
        list_.push_front(Entry{key, std::move(value), depth, Clock::now() + ttl_});
        index_[key] = list_.begin();
    }

    std::size_t Size() const {
        std::lock_guard lock(mu_);
        return list_.size();
    }

private:
    struct Entry {
        K                              key;
        V                              value;
        Depth                          depth{Depth::None};
        std::chrono::time_point<Clock> expires_at;
    };
    static bool IsExpired(const std::chrono::time_point<Clock>& tp) {
        return Clock::now() >= tp;
    }
    mutable std::mutex mu_;          // no suspend under this lock → std::mutex OK
    std::size_t        max_size_;
    Duration           ttl_;
    mutable std::list<Entry>   list_;
    mutable std::unordered_map<K, typename std::list<Entry>::iterator> index_;
};

// ════════════════════════════════════════════════════════════════════════════

struct GetResult {
    ArtistSongs data;
    Depth       have{Depth::None};   // depth actually available
    bool        network_needed{false};
};

class ArtistRepository final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "artist-repository";

    ArtistRepository(const userver::components::ComponentConfig&  config,
                     const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // ── Read ─────────────────────────────────────────────────────────────────

    // Returns data if available at depth ≥ want without network.
    // If network_needed=true, caller must fetch and call WriteThrough.
    GetResult GetArtistSongs(const ArtistRef& ref, Depth want) const;

    // Simple ref lookup (L2 → L1).
    std::optional<ArtistRef> Lookup(std::int64_t artist_id) const;

    // One-hop neighbours from L1 (role-filtered).  Used by FindPath.
    std::vector<CollabEdge>
    Neighbours(std::int64_t artist_id, const RoleMask& mask) const;

    // Current depth in L1.
    Depth GetFetchDepth(std::int64_t artist_id) const;

    // True if we have ANY data for this id in L2 (used for quick checks).
    bool HasAny(std::int64_t id) const;

    // ── Write ────────────────────────────────────────────────────────────────

    // Write to L1 first (durable), then warm L2.
    // Only advances depth monotonically.
    void WriteThrough(const ArtistSongs& data, Depth new_depth);

private:
    PersistentStore& store_;

    // L2 cache: id → (ArtistSongs, depth).
    mutable LruCache<std::int64_t, ArtistSongs> l2_;
};

} // namespace six_feat
