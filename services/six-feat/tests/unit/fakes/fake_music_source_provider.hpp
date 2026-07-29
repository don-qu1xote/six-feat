#pragma once

#include <six-feat-common/music_source_provider.hpp>
#include <stdexcept>
#include <utility>

namespace six_feat::test {

class FakeMusicSourceProvider final : public MusicSourceProvider {
 public:
  explicit FakeMusicSourceProvider(std::string name) : name_(std::move(name)) {}

  std::string_view Name() const override {
    return name_;
  }

  void SucceedWith(std::vector<ProviderEdge> edges) {
    edges_ = std::move(edges);
    should_throw_ = false;
  }

  void FailWith(std::string error_message) {
    error_message_ = std::move(error_message);
    should_throw_ = true;
  }

  std::vector<ProviderEdge> GetCollaborationEdges(
      const ArtistRef& /*seed*/, const std::string& /*user_token*/) const override {
    if (should_throw_) throw std::runtime_error(error_message_);
    return edges_;
  }

 private:
  std::string name_;
  std::vector<ProviderEdge> edges_;
  bool should_throw_{false};
  std::string error_message_{"fake provider failure"};
};

}  // namespace six_feat::test
