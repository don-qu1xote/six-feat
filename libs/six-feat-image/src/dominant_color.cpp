#include <algorithm>
#include <array>
#include <cstdint>
#include <limits>
#include <memory>
#include <six-feat-image/dominant_color.hpp>
#include <vector>

// Декодер — вендоренный header-only stb_image (vendor/stb_image.h, public
// domain). Системной зависимости он не добавляет: собирается вместе с этой
// библиотекой и больше нигде не разворачивается.
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_STDIO
#define STBI_NO_LINEAR
// Форматы, которые реально приходят с CDN Genius. Всё остальное отключено не
// ради килобайтов, а ради поверхности: сюда попадают байты из интернета.
#define STBI_ONLY_JPEG
#define STBI_ONLY_PNG
#define STBI_ONLY_GIF
#define STBI_ONLY_BMP
// Потолок на сторону кадра: декодер выделяет w*h*4 байта, и без ограничения
// «аватарка» с заголовком 60000x60000 просит 14 ГБ.
#define STBI_MAX_DIMENSIONS 8192
// Без SSE-веток: с ними stb тянет <emmintrin.h>, а clang-tidy разбирает эту
// единицу трансляции clang'ом поверх заголовков GCC — и спотыкается о
// встроенные функции, которых у него нет (clang-diagnostic-error в
// xmmintrin.h, джоба падает с кодом 123, даже когда в нашем коде чисто).
// Цена — чуть более медленный idct у JPEG; картинка проходит через декодер
// один раз за всю жизнь артиста, так что платить нечем.
#define STBI_NO_SIMD
// NOLINTEND(cppcoreguidelines-macro-usage)
#include "stb_image.h"

namespace six_feat::image {

namespace {

constexpr int kChannels = 4;

struct StbImageDeleter {
  void operator()(unsigned char* p) const noexcept {
    stbi_image_free(p);
  }
};

using StbImagePtr = std::unique_ptr<unsigned char, StbImageDeleter>;

std::string ToHex(int r, int g, int b) {
  static constexpr std::array<char, 16> kDigits{
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'};
  std::string out = "#______";
  const std::array<int, 3> channels{r, g, b};
  for (std::size_t i = 0; i < channels.size(); ++i) {
    const auto v = static_cast<unsigned>(std::clamp(channels[i], 0, 255));
    out[1 + i * 2] = kDigits[(v >> 4U) & 0xFU];
    out[2 + i * 2] = kDigits[v & 0xFU];
  }
  return out;
}

}  // namespace

std::optional<std::string> DominantColorHex(const void* bytes, std::size_t size) {
  if (bytes == nullptr || size == 0) return std::nullopt;
  if (size > static_cast<std::size_t>(std::numeric_limits<int>::max())) return std::nullopt;

  int width = 0;
  int height = 0;
  int source_channels = 0;
  StbImagePtr pixels{stbi_load_from_memory(static_cast<const stbi_uc*>(bytes),
                                           static_cast<int>(size),
                                           &width,
                                           &height,
                                           &source_channels,
                                           kChannels)};
  if (!pixels || width <= 0 || height <= 0) return std::nullopt;

  // Тот же порядок действий, что делал холст в браузере: сперва ужать до
  // сетки kSampleSize×kSampleSize, потом усреднить ячейки с alpha >= kMinAlpha.
  // Ужимаем усреднением по блоку (box filter) — так же, как ведёт себя
  // drawImage при уменьшении, и в отличие от выборки каждого N-го пикселя не
  // зависит от того, куда попала сетка.
  // Порядок важен именно из-за альфы: полупрозрачные пиксели, попав в одну
  // ячейку с непрозрачными, дают ячейку выше порога и в среднее входят —
  // ровно как на клиенте. Усреднение по исходным пикселям дало бы другой цвет.
  struct Cell {
    std::int64_t r{0}, g{0}, b{0}, a{0}, n{0};
  };
  std::vector<Cell> grid(static_cast<std::size_t>(kSampleSize) * kSampleSize);

  const unsigned char* p = pixels.get();
  for (int y = 0; y < height; ++y) {
    const int cell_y = std::min(
        kSampleSize - 1, static_cast<int>(static_cast<std::int64_t>(y) * kSampleSize / height));
    for (int x = 0; x < width; ++x) {
      const int cell_x = std::min(
          kSampleSize - 1, static_cast<int>(static_cast<std::int64_t>(x) * kSampleSize / width));
      const std::size_t src = (static_cast<std::size_t>(y) * width + x) * kChannels;
      auto& cell = grid[static_cast<std::size_t>(cell_y) * kSampleSize + cell_x];
      cell.r += p[src];
      cell.g += p[src + 1];
      cell.b += p[src + 2];
      cell.a += p[src + 3];
      ++cell.n;
    }
  }

  std::int64_t r_sum = 0, g_sum = 0, b_sum = 0, counted = 0;
  for (const auto& cell : grid) {
    if (cell.n == 0) continue;
    if (cell.a / cell.n < kMinAlpha) continue;
    r_sum += cell.r / cell.n;
    g_sum += cell.g / cell.n;
    b_sum += cell.b / cell.n;
    ++counted;
  }
  if (counted == 0) return std::nullopt;

  return ToHex(static_cast<int>((r_sum + counted / 2) / counted),
               static_cast<int>((g_sum + counted / 2) / counted),
               static_cast<int>((b_sum + counted / 2) / counted));
}

}  // namespace six_feat::image
