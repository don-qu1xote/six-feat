// ════════════════════════════════════════════════════════════════════════════
// role_mask.cpp  —  iteration 6
//
// Implementations moved verbatim from graph_handler.cpp / path_handler.cpp
// (ToLower, ParseRoleMask, RoleAllowed) plus RoleRank and EdgeStyleForRole
// that lived in graph_handler.cpp only.  NormalizeStr is the
// NormalizeName from genius_client.cpp, now shared.
// ════════════════════════════════════════════════════════════════════════════

#include "role_mask.hpp"

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>

namespace six_feat {

// ── Internal helpers ─────────────────────────────────────────────────────────

namespace {

std::string ToLower(std::string v) {
    std::transform(v.begin(), v.end(), v.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    return v;
}

} // namespace

// ── Public API ────────────────────────────────────────────────────────────────

RoleMask ParseRoleMask(const std::string& spec) {
    if (spec.empty()) return RoleMask{};   // all roles enabled by default
    RoleMask m{false, false, false, false};
    std::size_t start = 0;
    while (start <= spec.size()) {
        const std::size_t comma = spec.find(',', start);
        const std::size_t len   = (comma == std::string::npos)
                                      ? std::string::npos : comma - start;
        const std::string tok   = ToLower(spec.substr(start, len));
        if      (tok == "primary")  m.primary  = true;
        else if (tok == "producer") m.producer = true;
        else if (tok == "writer")   m.writer   = true;
        else if (tok == "featured") m.featured = true;
        if (comma == std::string::npos) break;
        start = comma + 1;
    }
    return m;
}

bool RoleAllowed(const std::string& role, const RoleMask& mask) {
    if (role == "featured") return mask.featured;
    if (role == "producer") return mask.producer;
    if (role == "writer")   return mask.writer;
    if (role == "primary")  return mask.primary;
    return false;
}

int RoleRank(std::string_view role) {
    if (role == "producer") return 4;
    if (role == "writer")   return 3;
    if (role == "featured") return 2;
    if (role == "primary")  return 1;
    return 0;
}

std::string_view EdgeStyleForRole(std::string_view role) {
    if (role == "featured") return "solid";
    if (role == "producer") return "dashed";
    return "dotted";
}

std::string NormalizeStr(std::string_view value) {
    std::string out;
    out.reserve(value.size());
    bool prev_space = false;
    for (unsigned char c : value) {
        if (std::isspace(c)) {
            if (!out.empty() && !prev_space) out.push_back(' ');
            prev_space = true;
        } else {
            out.push_back(static_cast<char>(std::tolower(c)));
            prev_space = false;
        }
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return out;
}

} // namespace six_feat
