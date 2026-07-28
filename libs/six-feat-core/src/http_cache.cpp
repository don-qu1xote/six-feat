#include <six-feat-core/http_cache.hpp>

#include <string_view>

namespace six_feat {

bool ETagMatches(const std::string& if_none_match, const std::string& etag) {
  if (if_none_match.empty()) return false;
  if (if_none_match == "*") return true;

  const auto strip_weak = [](std::string_view tag) {
    if (tag.substr(0, 2) == "W/") tag.remove_prefix(2);
    return tag;
  };
  const std::string_view target = strip_weak(etag);

  std::size_t pos = 0;
  while (pos <= if_none_match.size()) {
    const std::size_t comma = if_none_match.find(',', pos);
    std::string_view token{if_none_match};
    token = token.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
    while (!token.empty() && token.front() == ' ') token.remove_prefix(1);
    while (!token.empty() && token.back() == ' ') token.remove_suffix(1);
    if (strip_weak(token) == target) return true;
    if (comma == std::string::npos) break;
    pos = comma + 1;
  }
  return false;
}

}  // namespace six_feat