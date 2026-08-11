

#include <algorithm>
#include <cstdint>
#include <gtest/gtest.h>
#include <optional>
#include <six-feat-image/dominant_color.hpp>
#include <string>
#include <vector>

namespace {

struct Rgba {
  std::uint8_t r{0}, g{0}, b{0}, a{255};
};

std::uint32_t Crc32(const std::vector<std::uint8_t>& data) {
  std::uint32_t crc = 0xFFFFFFFFu;
  for (const auto byte : data) {
    crc ^= byte;
    for (int i = 0; i < 8; ++i) crc = (crc >> 1) ^ (0xEDB88320u & (~(crc & 1u) + 1u));
  }
  return crc ^ 0xFFFFFFFFu;
}

std::uint32_t Adler32(const std::vector<std::uint8_t>& data) {
  std::uint32_t a = 1, b = 0;
  for (const auto byte : data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}

void PushBe32(std::vector<std::uint8_t>& out, std::uint32_t v) {
  out.push_back(static_cast<std::uint8_t>(v >> 24));
  out.push_back(static_cast<std::uint8_t>(v >> 16));
  out.push_back(static_cast<std::uint8_t>(v >> 8));
  out.push_back(static_cast<std::uint8_t>(v));
}

void PushChunk(std::vector<std::uint8_t>& out,
               const char (&kind)[5],
               const std::vector<std::uint8_t>& payload) {
  PushBe32(out, static_cast<std::uint32_t>(payload.size()));
  std::vector<std::uint8_t> body(kind, kind + 4);
  body.insert(body.end(), payload.begin(), payload.end());
  out.insert(out.end(), body.begin(), body.end());
  PushBe32(out, Crc32(body));
}

std::string MakePng(int width, int height, const std::vector<Rgba>& pixels) {
  std::vector<std::uint8_t> raw;
  raw.reserve(static_cast<std::size_t>(height) * (1 + width * 4));
  for (int y = 0; y < height; ++y) {
    raw.push_back(0);
    for (int x = 0; x < width; ++x) {
      const auto& px = pixels[static_cast<std::size_t>(y) * width + x];
      raw.push_back(px.r);
      raw.push_back(px.g);
      raw.push_back(px.b);
      raw.push_back(px.a);
    }
  }

  std::vector<std::uint8_t> z{0x78, 0x01};
  std::size_t offset = 0;
  while (offset < raw.size()) {
    const std::size_t len = std::min<std::size_t>(65535, raw.size() - offset);
    z.push_back(offset + len >= raw.size() ? 1 : 0);
    z.push_back(static_cast<std::uint8_t>(len));
    z.push_back(static_cast<std::uint8_t>(len >> 8));
    z.push_back(static_cast<std::uint8_t>(~len));
    z.push_back(static_cast<std::uint8_t>(~len >> 8));
    z.insert(z.end(), raw.begin() + offset, raw.begin() + offset + len);
    offset += len;
  }
  PushBe32(z, Adler32(raw));

  std::vector<std::uint8_t> png{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
  std::vector<std::uint8_t> ihdr;
  PushBe32(ihdr, static_cast<std::uint32_t>(width));
  PushBe32(ihdr, static_cast<std::uint32_t>(height));
  ihdr.insert(ihdr.end(), {8, 6, 0, 0, 0});
  PushChunk(png, "IHDR", ihdr);
  PushChunk(png, "IDAT", z);
  PushChunk(png, "IEND", {});

  return std::string(png.begin(), png.end());
}

std::optional<std::string> ColorOf(const std::string& png) {
  return six_feat::image::DominantColorHex(png.data(), png.size());
}

std::vector<Rgba> Fill(int width, int height, Rgba colour) {
  return std::vector<Rgba>(static_cast<std::size_t>(width) * height, colour);
}

}  // namespace

TEST(DominantColor, SolidImageIsItsOwnAverage) {
  const auto png = MakePng(24, 24, Fill(24, 24, Rgba{200, 50, 10, 255}));

  EXPECT_EQ(ColorOf(png), "#c8320a");
}

TEST(DominantColor, HalvesAverageToTheMidpoint) {
  auto pixels = Fill(24, 24, Rgba{});
  for (int y = 0; y < 24; ++y) {
    for (int x = 0; x < 24; ++x) {
      pixels[static_cast<std::size_t>(y) * 24 + x] =
          x < 12 ? Rgba{255, 0, 0, 255} : Rgba{0, 0, 255, 255};
    }
  }

  EXPECT_EQ(ColorOf(MakePng(24, 24, pixels)), "#800080");
}

TEST(DominantColor, SizeThatIsNotAMultipleOfTheGridStillWorks) {
  const auto png = MakePng(37, 29, Fill(37, 29, Rgba{16, 32, 48, 255}));

  EXPECT_EQ(ColorOf(png), "#102030");
}

TEST(DominantColor, IsDeterministic) {
  const auto png = MakePng(19, 23, Fill(19, 23, Rgba{7, 199, 128, 255}));

  EXPECT_EQ(ColorOf(png), ColorOf(png));
}

TEST(DominantColor, FullyTransparentImageHasNoColour) {
  const auto png = MakePng(24, 24, Fill(24, 24, Rgba{255, 255, 255, 0}));

  EXPECT_FALSE(ColorOf(png).has_value());
}

TEST(DominantColor, TransparentAreasDoNotDragTheAverageTowardsBlack) {
  auto pixels = Fill(24, 24, Rgba{0, 0, 0, 0});
  for (int y = 6; y < 18; ++y) {
    for (int x = 6; x < 18; ++x) {
      pixels[static_cast<std::size_t>(y) * 24 + x] = Rgba{10, 220, 140, 255};
    }
  }

  EXPECT_EQ(ColorOf(MakePng(24, 24, pixels)), "#0adc8c");
}

TEST(DominantColor, DownscaleHappensBeforeTheAlphaThreshold) {
  auto pixels = Fill(24, 24, Rgba{});
  for (int y = 0; y < 24; ++y) {
    for (int x = 0; x < 24; ++x) {
      const bool opaque = ((x + y) % 2) == 0;
      pixels[static_cast<std::size_t>(y) * 24 + x] =
          opaque ? Rgba{255, 255, 255, 255} : Rgba{0, 0, 0, 0};
    }
  }

  const auto colour = ColorOf(MakePng(24, 24, pixels));
  ASSERT_TRUE(colour.has_value());
  EXPECT_EQ(*colour, "#7f7f7f");
}

TEST(DominantColor, GarbageBytesAreNotAColour) {
  const std::string junk = "this is definitely not an image";

  EXPECT_FALSE(six_feat::image::DominantColorHex(junk.data(), junk.size()).has_value());
}

TEST(DominantColor, EmptyInputIsNotAColour) {
  EXPECT_FALSE(six_feat::image::DominantColorHex(nullptr, 0).has_value());
  EXPECT_FALSE(six_feat::image::DominantColorHex("", 0).has_value());
}
