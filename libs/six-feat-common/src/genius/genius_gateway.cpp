
#include "genius/genius_gateway.hpp"

#include "core/request_id.hpp"

#include "domain/role_mask.hpp"

#include "schemas/components/genius_gateway_schema.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <userver/clients/http/client.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/components/statistics_storage.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/cancel.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/statistics/writer.hpp>
#include <userver/yaml_config/merge_schemas.hpp>
#include <vector>

namespace six_feat {

using namespace userver;

namespace {

constexpr std::size_t kMaxSearchCandidates = 8;

int RequirePositive(std::string_view param, int value) {
  if (value <= 0) {
    throw std::runtime_error("genius-gateway: " + std::string(param) +
                             " must be a positive integer, got " + std::to_string(value));
  }
  return value;
}

double RequirePositive(std::string_view param, double value) {
  if (!(value > 0.0)) {
    throw std::runtime_error("genius-gateway: " + std::string(param) +
                             " must be a positive number, got " + std::to_string(value));
  }
  return value;
}

std::string RedactUrl(std::string_view url) {
  static constexpr std::array<std::string_view, 4> kSensitiveParams{
      "access_token", "token", "client_secret", "authorization"};

  const auto qpos = url.find('?');
  if (qpos == std::string_view::npos) return std::string{url};

  std::string out{url.substr(0, qpos + 1)};
  std::string_view query = url.substr(qpos + 1);
  bool first = true;
  while (!query.empty()) {
    const auto amp = query.find('&');
    const auto piece = query.substr(0, amp);
    const auto eq_it = std::find(piece.begin(), piece.end(), '=');
    const auto eq = eq_it == piece.end()
                        ? std::string_view::npos
                        : static_cast<std::string_view::size_type>(eq_it - piece.begin());
    const auto key = piece.substr(0, eq);

    const bool sensitive =
        std::find(kSensitiveParams.begin(), kSensitiveParams.end(), key) != kSensitiveParams.end();
    if (!first) out += '&';
    first = false;
    out += std::string{key};
    out += '=';
    out += sensitive ? "***"
                     : std::string{eq == std::string_view::npos ? std::string_view{}
                                                                : piece.substr(eq + 1)};

    if (amp == std::string_view::npos) break;
    query = query.substr(amp + 1);
  }
  return out;
}

std::string UrlEncode(std::string_view value) {
  static constexpr const char* kHex = "0123456789ABCDEF";
  std::string out;
  out.reserve(value.size() * 3);
  for (unsigned char c : value) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~')
      out.push_back(static_cast<char>(c));
    else {
      out.push_back('%');
      out.push_back(kHex[c >> 4]);
      out.push_back(kHex[c & 0x0F]);
    }
  }
  return out;
}

int Levenshtein(const std::string& a, const std::string& b) {
  const std::size_t n = a.size(), m = b.size();
  if (!n) return static_cast<int>(m);
  if (!m) return static_cast<int>(n);
  thread_local std::vector<int> prev, cur;
  prev.assign(m + 1, 0);
  cur.assign(m + 1, 0);
  for (std::size_t j = 0; j <= m; ++j) prev[j] = static_cast<int>(j);
  for (std::size_t i = 1; i <= n; ++i) {
    cur[0] = static_cast<int>(i);
    for (std::size_t j = 1; j <= m; ++j) {
      const int cost = (a[i - 1] == b[j - 1]) ? 0 : 1;
      cur[j] = std::min({prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost});
    }
    std::swap(prev, cur);
  }
  return prev[m];
}

static constexpr std::size_t kMinSubstringLen = 4;

double Similarity(const std::string& a, const std::string& b) {
  if (a == b) return 1.0;
  const std::size_t maxlen = std::max(a.size(), b.size());
  if (!maxlen) return 1.0;
  double sim = 1.0 - static_cast<double>(Levenshtein(a, b)) / static_cast<double>(maxlen);

  const std::size_t minlen = std::min(a.size(), b.size());
  if (minlen > kMinSubstringLen) {
    const bool a_in_b = (b.find(a) != std::string::npos);
    const bool b_in_a = (a.find(b) != std::string::npos);
    if (a_in_b || b_in_a) {
      const double ratio = static_cast<double>(minlen) / static_cast<double>(maxlen);
      const double boost = 0.90 * ratio;
      sim = std::max(sim, boost);
    }
  }
  return sim;
}

template <typename Response>
int ParseIntHeader(const Response& resp, std::string_view name) {
  const auto& headers = resp.headers();
  auto it = headers.find(std::string{name});
  if (it == headers.end()) return -1;
  try {
    return std::stoi(it->second);
  } catch (...) {
    return -1;
  }
}

template <typename Response>
std::int64_t ParseInt64Header(const Response& resp, std::string_view name) {
  const auto& headers = resp.headers();
  auto it = headers.find(std::string{name});
  if (it == headers.end()) return 0;
  try {
    return std::stoll(it->second);
  } catch (...) {
    return 0;
  }
}

constexpr std::string_view kGeniusDefaultAvatarMarker = "default_cover_image";

std::string NormalizeArtistImageUrl(std::string image_url) {
  if (image_url.find(kGeniusDefaultAvatarMarker) != std::string::npos) {
    return {};
  }
  return image_url;
}

ArtistRef ParseArtistObject(const formats::json::Value& obj) {
  return {obj["id"].As<std::int64_t>(0),
          obj["name"].As<std::string>(""),
          NormalizeArtistImageUrl(obj["image_url"].As<std::string>("")),
          obj["url"].As<std::string>("")};
}

std::vector<ArtistRef> ParseArtistArray(const formats::json::Value& arr) {
  if (!arr.IsArray()) return {};
  std::vector<ArtistRef> out;
  for (const auto& a : arr) {
    auto r = ParseArtistObject(a);
    if (r.id) out.push_back(std::move(r));
  }
  return out;
}

}  // namespace

GeniusGateway::GeniusGateway(const components::ComponentConfig& config,
                             const components::ComponentContext& context)
    : ComponentBase(config, context),
      http_client_(context.FindComponent<components::HttpClient>().GetHttpClient()),
      genius_base_url_(config["genius-base-url"].As<std::string>("https://api.genius.com")),
      songs_limit_fg_(RequirePositive("songs-limit-fg", config["songs-limit-fg"].As<int>(40))),
      songs_limit_bg_(RequirePositive("songs-limit-bg", config["songs-limit-bg"].As<int>(80))),
      match_threshold_(config["match-threshold"].As<double>(0.9)),
      backoff_max_attempts_(
          RequirePositive("backoff-max-attempts", config["backoff-max-attempts"].As<int>(4))),
      backoff_base_ms_(std::chrono::milliseconds{
          RequirePositive("backoff-base-ms", config["backoff-base-ms"].As<int>(200))}),
      backoff_cap_ms_(std::chrono::milliseconds{
          RequirePositive("backoff-cap-ms", config["backoff-cap-ms"].As<int>(10000))}),
      pipeline_(LaneConfig{RequirePositive("lane-fg-tokens-per-sec",
                                           config["lane-fg-tokens-per-sec"].As<double>(8.0)),
                           RequirePositive("lane-fg-burst", config["lane-fg-burst"].As<int>(8)),
                           RequirePositive("lane-fg-max-concurrent",
                                           config["lane-fg-max-concurrent"].As<int>(8))},
                LaneConfig{RequirePositive("lane-bg-tokens-per-sec",
                                           config["lane-bg-tokens-per-sec"].As<double>(2.0)),
                           RequirePositive("lane-bg-burst", config["lane-bg-burst"].As<int>(2)),
                           RequirePositive("lane-bg-max-concurrent",
                                           config["lane-bg-max-concurrent"].As<int>(1))},
                RequirePositive("cb-failure-threshold", config["cb-failure-threshold"].As<int>(5)),
                std::chrono::seconds{
                    RequirePositive("cb-open-seconds", config["cb-open-seconds"].As<int>(30))}) {
  auto& storage = context.FindComponent<components::StatisticsStorage>().GetStorage();
  statistics_holder_ = storage.RegisterWriter(
      "genius-gateway", [this](utils::statistics::Writer& writer) { ExtendStatistics(writer); });
}

GeniusGateway::~GeniusGateway() {
  statistics_holder_.Unregister();
}

void GeniusGateway::ExtendStatistics(utils::statistics::Writer& writer) const {
  const auto state = pipeline_.CbState();
  writer["circuit_breaker"]["state"] = static_cast<int>(state);
  writer["circuit_breaker"]["closed"] = state == CircuitBreaker::State::Closed ? 1 : 0;
  writer["circuit_breaker"]["open"] = state == CircuitBreaker::State::Open ? 1 : 0;
  writer["circuit_breaker"]["half_open"] = state == CircuitBreaker::State::HalfOpen ? 1 : 0;

  writer["lane"]["foreground"]["tokens_available"] = pipeline_.FgTokensAvailable();
  writer["lane"]["foreground"]["slots_available"] = pipeline_.FgSlotsAvailable();
  writer["lane"]["background"]["tokens_available"] = pipeline_.BgTokensAvailable();
  writer["lane"]["background"]["slots_available"] = pipeline_.BgSlotsAvailable();
}

std::string GeniusGateway::GeniusGet(const std::string& url,
                                     Lane lane,
                                     const std::string& user_token) const {
  if (user_token.empty()) throw GeniusHttpError{401, "no Genius session token — user must log in"};
  const std::string auth = "Bearer " + user_token;
  const std::string& request_id = CurrentRequestId();
  int attempt = 0;
  int last_5xx_status = 502;

  while (true) {
    auto guard = pipeline_.Acquire(lane);
    bool failure_already_recorded_for_this_attempt = false;

    try {
      const auto resp = http_client_.CreateRequest()
                            .get(url)
                            .headers({{"Authorization", auth}, {"X-Request-Id", request_id}})
                            .timeout(std::chrono::seconds{5})
                            .retry(0)
                            .perform();
      const int status = resp->status_code();
      const int remaining = ParseIntHeader(*resp, "X-RateLimit-Remaining");
      const auto reset_ts = ParseInt64Header(*resp, "X-RateLimit-Reset");

      pipeline_.OnResponse(guard, status, remaining, reset_ts);

      if (status == 429) {
        const auto wait_secs = [&]() -> std::int64_t {
          using SC = std::chrono::system_clock;
          const auto now_unix = static_cast<std::int64_t>(
              std::chrono::duration_cast<std::chrono::seconds>(SC::now().time_since_epoch())
                  .count());
          return (reset_ts > now_unix) ? (reset_ts - now_unix + 1) : 60;
        }();
        LOG_WARNING() << "[GW] request_id=" << request_id << " 429 on " << RedactUrl(url)
                      << " — sleeping " << wait_secs << "s";
        guard = ResiliencePipeline::Guard{};
        engine::InterruptibleSleepFor(std::chrono::seconds{wait_secs});
        ++attempt;
        if (attempt >= backoff_max_attempts_) {
          LOG_ERROR() << "[GW] request_id=" << request_id << " 429 retries exhausted on "
                      << RedactUrl(url);
          throw GeniusHttpError{503, "429 rate limit exhausted retries"};
        }
        continue;
      }

      if (status >= 200 && status < 300) return resp->body();

      if (status >= 400 && status < 500)
        throw GeniusHttpError{status, "HTTP " + std::to_string(status)};

      last_5xx_status = status;
      failure_already_recorded_for_this_attempt = true;
      LOG_WARNING() << "[GW] request_id=" << request_id << " HTTP " << status
                    << " attempt=" << attempt << " url=" << RedactUrl(url);

    } catch (const GeniusHttpError&) {
      throw;
    } catch (const std::exception& ex) {
      if (engine::current_task::ShouldCancel()) {
        LOG_DEBUG() << "[GW] request_id=" << request_id
                    << " request cancelled (client gone / deadline) "
                       "for "
                    << RedactUrl(url) << " — not counted as upstream failure";
        throw GeniusHttpError{499, "client request cancelled"};
      }

      if (std::string(ex.what()).find("deadline propagation") != std::string::npos) {
        LOG_WARNING() << "[GW] request_id=" << request_id << " deadline budget exhausted for "
                      << RedactUrl(url) << " — not counted as upstream failure";
        throw GeniusHttpError{504, "deadline exhausted for this request"};
      }
      pipeline_.OnNetworkError();
      failure_already_recorded_for_this_attempt = true;
      LOG_WARNING() << "[GW] request_id=" << request_id << " network error attempt=" << attempt
                    << ": " << ex.what();
    }

    ++attempt;
    if (attempt >= backoff_max_attempts_) {
      if (!failure_already_recorded_for_this_attempt) {
        pipeline_.OnNetworkError();
      }
      throw GeniusHttpError{last_5xx_status, "exhausted retries: " + url};
    }
    const auto backoff = ExponentialBackoff(attempt, backoff_base_ms_, backoff_cap_ms_);
    LOG_INFO() << "[GW] request_id=" << request_id << " retrying attempt=" << attempt << " in "
               << backoff.count() << "ms";
    engine::InterruptibleSleepFor(backoff);
  }
}

std::vector<Candidate> GeniusGateway::ResolveCandidates(const std::string& query,
                                                        const std::string& user_token) const {
  const std::string body =
      GeniusGet(genius_base_url_ + "/search?q=" + UrlEncode(query), Lane::Foreground, user_token);
  const auto json = formats::json::FromString(body);
  const auto& hits = json["response"]["hits"];

  std::vector<Candidate> out;
  std::unordered_set<std::int64_t> seen;
  const std::string q = NormalizeStr(query);

  if (hits.IsArray()) {
    for (const auto& hit : hits) {
      const auto& p = hit["result"]["primary_artist"];
      const auto id = p["id"].As<std::int64_t>(0);
      if (!id || seen.count(id)) continue;
      seen.insert(id);
      Candidate c;
      c.id = id;
      c.name = p["name"].As<std::string>("");
      c.image = NormalizeArtistImageUrl(p["image_url"].As<std::string>(""));
      c.url = p["url"].As<std::string>("");
      c.score = Similarity(q, NormalizeStr(c.name));
      out.push_back(std::move(c));
    }
  }
  std::sort(out.begin(), out.end(), [](const Candidate& a, const Candidate& b) {
    return a.score > b.score;
  });
  if (out.size() > kMaxSearchCandidates) out.resize(kMaxSearchCandidates);
  return out;
}

std::optional<ArtistRef> GeniusGateway::FetchArtistById(std::int64_t id,
                                                        Lane lane,
                                                        const std::string& user_token) const {
  try {
    const std::string body =
        GeniusGet(genius_base_url_ + "/artists/" + std::to_string(id), lane, user_token);
    const auto& a = formats::json::FromString(body)["response"]["artist"];
    if (!a.IsObject()) return std::nullopt;
    return ArtistRef{a["id"].As<std::int64_t>(id),
                     a["name"].As<std::string>(""),
                     NormalizeArtistImageUrl(a["image_url"].As<std::string>("")),
                     a["url"].As<std::string>("")};
  } catch (const GeniusHttpError& e) {
    if (e.status_code == 401) throw;
    LOG_WARNING() << "[GW] FetchArtistById(" << id << "): " << e.what();
    return std::nullopt;
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[GW] FetchArtistById(" << id << "): " << ex.what();
    return std::nullopt;
  }
}

std::vector<std::int64_t> GeniusGateway::FetchSongList(std::int64_t artist_id,
                                                       int limit,
                                                       Lane lane,
                                                       const std::string& user_token) const {
  const std::string url = genius_base_url_ + "/artists/" + std::to_string(artist_id) +
                          "/songs?sort=popularity&per_page=" + std::to_string(limit);

  const auto json = formats::json::FromString(GeniusGet(url, lane, user_token));
  const auto songs_arr = json["response"]["songs"];

  std::vector<std::int64_t> ids;
  if (songs_arr.IsArray()) {
    ids.reserve(songs_arr.GetSize());
    for (const auto& s : songs_arr) {
      const auto sid = s["id"].As<std::int64_t>(0);
      if (sid) ids.push_back(sid);
    }
  }
  return ids;
}

std::optional<SongRecord> GeniusGateway::FetchSongDetail(std::int64_t song_id,
                                                         Lane lane,
                                                         const std::string& user_token) const {
  try {
    const std::string url = genius_base_url_ + "/songs/" + std::to_string(song_id);
    const auto json = formats::json::FromString(GeniusGet(url, lane, user_token));
    const auto& song = json["response"]["song"];
    if (!song.IsObject()) return std::nullopt;

    SongRecord rec;
    rec.id = song_id;
    rec.title = song["title"].As<std::string>("");
    if (rec.title.empty()) rec.title = song["full_title"].As<std::string>("");
    rec.popularity = song["stats"]["pageviews"].As<std::int64_t>(0);

    const auto push = [&](const formats::json::Value& arr, const char* role) {
      for (const auto& a : ParseArtistArray(arr))
        if (a.id) rec.credits.push_back({a, role});
    };
    if (song.HasMember("primary_artist")) {
      auto pa = ParseArtistObject(song["primary_artist"]);
      if (pa.id) rec.credits.push_back({std::move(pa), "primary"});
    }
    push(song["producer_artists"], "producer");
    push(song["writer_artists"], "writer");
    push(song["featured_artists"], "featured");
    return rec;

  } catch (const GeniusHttpError& e) {
    if (e.status_code == 401) throw;
    LOG_WARNING() << "[GW] FetchSongDetail(" << song_id << "): " << e.what();
    return std::nullopt;
  } catch (const std::exception& ex) {
    LOG_WARNING() << "[GW] FetchSongDetail(" << song_id << "): " << ex.what();
    return std::nullopt;
  }
}

yaml_config::Schema GeniusGateway::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<components::ComponentBase>(kGeniusGatewayComponentSchema);
}

}  // namespace six_feat