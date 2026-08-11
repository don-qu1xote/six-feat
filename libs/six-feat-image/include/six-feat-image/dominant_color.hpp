#pragma once

#include <cstddef>
#include <optional>
#include <string>

namespace six_feat::image {

inline constexpr int kSampleSize = 12;

inline constexpr int kMinAlpha = 16;

std::optional<std::string> DominantColorHex(const void* bytes, std::size_t size);

}  // namespace six_feat::image
