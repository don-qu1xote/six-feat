#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/shared_mutex.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

struct ArtistRef {
  std::int64_t id{0};
  std::string name;
  std::string image;
  std::string url; // genius.com artist page (for Ctrl+Click)
};

struct SongDetail {
  std::string title;
  ArtistRef primary;
  std::vector<ArtistRef> producers;
  std::vector<ArtistRef> writers;
  std::vector<ArtistRef> featured;
};

// A search hit considered for disambiguation ("Did you mean?").
struct Candidate {
  std::int64_t id{0};
  std::string name;
  std::string image;
  std::string url;
  double score{0.0}; // fuzzy similarity to the query, 0..1
};

// Which role types to keep when building the graph (server-side ?roles=
// filter).
struct RoleMask {
  bool primary{true};
  bool producer{true};
  bool writer{true};
  bool featured{true};
};

class GraphHandler final : public userver::server::handlers::HttpHandlerBase {
public:
  static constexpr std::string_view kName = "handler-graph";

  GraphHandler(const userver::components::ComponentConfig &config,
               const userver::components::ComponentContext &context);

  std::string HandleRequestThrow(
      const userver::server::http::HttpRequest &request,
      userver::server::request::RequestContext &context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

private:
  // Stage 0: two-step search. Returns candidates scored against `query`.
  std::vector<Candidate> ResolveCandidates(const std::string &query) const;

  // Fetch canonical artist info by id (used for ?id= / shareable URLs).
  std::optional<ArtistRef> FetchArtist(std::int64_t id) const;

  // Build the collaboration graph JSON for an already-resolved seed artist.
  std::string BuildGraphForSeed(const ArtistRef &seed,
                                const RoleMask &roles) const;

  userver::clients::http::Client &http_client_;
  const std::string genius_token_;
  const std::string genius_base_url_;
  const int songs_limit_;
  const double match_threshold_; // confidence below which we disambiguate

  mutable userver::engine::SharedMutex graph_cache_mutex_;
  mutable std::unordered_map<std::string, std::string> graph_cache_;

  mutable userver::engine::Mutex song_cache_mutex_;
  mutable std::unordered_map<std::int64_t, std::optional<SongDetail>>
      song_cache_;
};

} // namespace six_feat
