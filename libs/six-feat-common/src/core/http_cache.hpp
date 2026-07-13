#pragma once

// ════════════════════════════════════════════════════════════════════════════
// http_cache.hpp — RFC 7232 §2.3 weak-ETag helpers shared across handlers.
//
// [SF-API-04] graph_handler.cpp originated this weak-comparison logic; search
// and path now need the identical If-None-Match handling, so it's hoisted
// here rather than tripled. Only the comparison is shared — each handler
// still builds its own ETag *value* from the parameters/state that actually
// determine its response body (graph: seed+depth+song_count+mask+limit;
// path: from/to fetch state+mask; search: normalized query), since those
// keys have nothing in common beyond "hash a few fields into a weak tag".
// ════════════════════════════════════════════════════════════════════════════

#include <string>

namespace six_feat {

// Weak comparison for If-None-Match: strips an optional "W/" prefix from
// each side and compares opaque-tags only. `if_none_match` may carry a
// comma-separated list, or "*" to match unconditionally.
bool ETagMatches(const std::string& if_none_match, const std::string& etag);

} // namespace six_feat
