#pragma once

#include "domain/domain_types.hpp"

#include <string>
#include <string_view>

namespace six_feat {

RoleMask ParseRoleMask(const std::string& spec);

bool RoleAllowed(const std::string& role, const RoleMask& mask);

int RoleRank(std::string_view role);

std::string_view EdgeStyleForRole(std::string_view role);

std::string NormalizeStr(std::string_view value);

}  // namespace six_feat