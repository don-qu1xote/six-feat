#pragma once

// ════════════════════════════════════════════════════════════════════════════
// role_mask.hpp  —  iteration 6
//
// Shared role-related utilities extracted from graph_handler.cpp and
// path_handler.cpp where they were duplicated verbatim.
//
// ParseRoleMask   — converts comma-separated query string into RoleMask
// RoleAllowed     — tests a credit role against the active mask
// RoleRank        — numeric dominance rank (producer > writer > featured > primary)
// EdgeStyleForRole— CSS edge-style hint for the frontend
// NormalizeStr    — lower-case + collapse whitespace (used in fuzzy match)
// ════════════════════════════════════════════════════════════════════════════

#include "domain_types.hpp"

#include <string>
#include <string_view>

namespace six_feat {

// Parse "primary,producer,featured" → RoleMask.
// Empty string → all roles enabled.
RoleMask ParseRoleMask(const std::string& spec);

// True if `role` is enabled in `mask`.
bool RoleAllowed(const std::string& role, const RoleMask& mask);

// Numeric dominance rank: producer(4) > writer(3) > featured(2) > primary(1).
// Used to pick the "dominant role" label on a multi-role edge.
int RoleRank(std::string_view role);

// Frontend edge-style hint.
std::string_view EdgeStyleForRole(std::string_view role);

// Lower-case + collapse interior whitespace + trim.
// Shared by fuzzy-match code in GeniusGateway and CollabService.
std::string NormalizeStr(std::string_view value);

} // namespace six_feat
