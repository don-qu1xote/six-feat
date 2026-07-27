#pragma once

#include <string>

namespace six_feat {

bool ETagMatches(const std::string& if_none_match, const std::string& etag);

}