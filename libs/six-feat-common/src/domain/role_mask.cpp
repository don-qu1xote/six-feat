
#include "domain/role_mask.hpp"

#include <cstdint>
#include <string>
#include <string_view>

namespace six_feat {

namespace {

char32_t DecodeUtf8(std::string_view s, std::size_t& i) {
  const unsigned char c0 = static_cast<unsigned char>(s[i]);
  std::size_t len = 0;
  char32_t cp = 0;
  if ((c0 & 0x80) == 0x00) {
    len = 1;
    cp = c0;
  } else if ((c0 & 0xE0) == 0xC0) {
    len = 2;
    cp = c0 & 0x1Fu;
  } else if ((c0 & 0xF0) == 0xE0) {
    len = 3;
    cp = c0 & 0x0Fu;
  } else if ((c0 & 0xF8) == 0xF0) {
    len = 4;
    cp = c0 & 0x07u;
  } else {
    ++i;
    return c0;
  }
  if (len == 1) {
    ++i;
    return cp;
  }
  if (i + len > s.size()) {
    ++i;
    return c0;
  }
  for (std::size_t k = 1; k < len; ++k) {
    const unsigned char cc = static_cast<unsigned char>(s[i + k]);
    if ((cc & 0xC0) != 0x80) {
      ++i;
      return c0;
    }
    cp = (cp << 6) | (cc & 0x3Fu);
  }
  i += len;
  return cp;
}

void EncodeUtf8(char32_t cp, std::string& out) {
  if (cp <= 0x7F) {
    out.push_back(static_cast<char>(cp));
  } else if (cp <= 0x7FF) {
    out.push_back(static_cast<char>(0xC0u | (cp >> 6)));
    out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
  } else if (cp <= 0xFFFF) {
    out.push_back(static_cast<char>(0xE0u | (cp >> 12)));
    out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
    out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
  } else {
    out.push_back(static_cast<char>(0xF0u | (cp >> 18)));
    out.push_back(static_cast<char>(0x80u | ((cp >> 12) & 0x3Fu)));
    out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
    out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
  }
}

char32_t ToLowerCodepoint(char32_t cp) {
  if (cp >= U'A' && cp <= U'Z') return cp + 0x20;
  if (cp >= 0x00C0 && cp <= 0x00D6) return cp + 0x20;
  if (cp >= 0x00D8 && cp <= 0x00DE) return cp + 0x20;
  if (cp >= 0x0400 && cp <= 0x040F) return cp + 0x50;
  if (cp >= 0x0410 && cp <= 0x042F) return cp + 0x20;
  return cp;
}

bool IsAsciiSpaceCodepoint(char32_t cp) {
  return cp == U' ' || cp == U'\t' || cp == U'\n' || cp == U'\r' || cp == U'\f' || cp == U'\v';
}

std::string ToLower(std::string_view v) {
  std::string out;
  out.reserve(v.size());
  std::size_t i = 0;
  for (; i < v.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(v[i]);
    if (c >= 0x80) break;
    out.push_back((c >= 'A' && c <= 'Z') ? static_cast<char>(c + 0x20) : static_cast<char>(c));
  }
  while (i < v.size()) {
    EncodeUtf8(ToLowerCodepoint(DecodeUtf8(v, i)), out);
  }
  return out;
}

}  // namespace

RoleMask ParseRoleMask(const std::string& spec) {
  if (spec.empty()) return RoleMask{};
  RoleMask m{false, false, false, false};
  std::size_t start = 0;
  while (start <= spec.size()) {
    const std::size_t comma = spec.find(',', start);
    const std::size_t len = (comma == std::string::npos) ? std::string::npos : comma - start;
    const std::string tok = ToLower(std::string_view(spec).substr(start, len));
    if (tok == "primary")
      m.primary = true;
    else if (tok == "producer")
      m.producer = true;
    else if (tok == "writer")
      m.writer = true;
    else if (tok == "featured")
      m.featured = true;
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return m;
}

bool RoleAllowed(const std::string& role, const RoleMask& mask) {
  if (role == "featured") return mask.featured;
  if (role == "producer") return mask.producer;
  if (role == "writer") return mask.writer;
  if (role == "primary") return mask.primary;
  return false;
}

int RoleRank(std::string_view role) {
  if (role == "producer") return 4;
  if (role == "writer") return 3;
  if (role == "featured") return 2;
  if (role == "primary") return 1;
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
  std::size_t i = 0;
  while (i < value.size()) {
    const char32_t cp = DecodeUtf8(value, i);
    if (IsAsciiSpaceCodepoint(cp)) {
      if (!out.empty() && !prev_space) out.push_back(' ');
      prev_space = true;
    } else {
      EncodeUtf8(ToLowerCodepoint(cp), out);
      prev_space = false;
    }
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

}  // namespace six_feat