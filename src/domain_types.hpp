#pragma once

// ════════════════════════════════════════════════════════════════════════════
// domain_types.hpp  —  iteration 6
//
// Single source of truth for all domain types shared across layers.
// Zero userver dependencies — included by every layer without pulling
// in framework headers.
//
// Depth enum: monotonically increasing scan coverage for an artist.
//   None       — no data in L1 yet.
//   Foreground — top-N songs (songs-limit-fg, fast path).
//   Full       — deep scan (songs-limit-bg, background worker).
// ════════════════════════════════════════════════════════════════════════════

#include <cstdint>
#include <string>
#include <vector>

namespace six_feat {

// ── Artist node ─────────────────────────────────────────────────────────────

struct ArtistRef {
    std::int64_t id{0};
    std::string  name;
    std::string  image;
    std::string  url;
};

// ── Credit on a track ───────────────────────────────────────────────────────

struct TrackCredit {
    ArtistRef   artist;
    std::string role;   // "primary" | "featured" | "producer" | "writer"
};

// ── Song with its full credit list ──────────────────────────────────────────

struct SongRecord {
    std::int64_t             id{0};    // Genius song id
    std::string              title;
    std::vector<TrackCredit> credits;
};

// ── All songs for one seed artist ───────────────────────────────────────────

struct ArtistSongs {
    ArtistRef               seed;
    std::vector<SongRecord> songs;
};

// ── Search candidate (fuzzy name resolution) ────────────────────────────────

struct Candidate {
    std::int64_t id{0};
    std::string  name;
    std::string  image;
    std::string  url;
    double       score{0.0};
};

// ── Role filter bitmask ─────────────────────────────────────────────────────

struct RoleMask {
    bool primary{true};
    bool producer{true};
    bool writer{true};
    bool featured{true};
};

// ── L1 persistence depth (monotonically increasing) ─────────────────────────

enum class Depth : int {
    None       = 0,   // no data in persistent store
    Foreground = 1,   // top songs-limit-fg songs stored
    Full       = 2,   // deep scan (songs-limit-bg) stored
};

// ── Background enrichment job ────────────────────────────────────────────────

struct EnrichmentJob {
    std::int64_t artist_id{0};
    Depth        target{Depth::Full};
    // populated from node_info so the worker can call FetchSongList without
    // a separate artist lookup
    std::string  name;
    std::string  image;
    std::string  url;
};

} // namespace six_feat
