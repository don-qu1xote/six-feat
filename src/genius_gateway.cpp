// ════════════════════════════════════════════════════════════════════════════
// genius_gateway.cpp  —  iteration 6
//
// Network layer only.  Ported from genius_client.cpp (I/O portion) with:
//   • Lane-aware calls to ResiliencePipeline::Acquire(lane).
//   • FetchSongList / FetchSongDetail split out as first-class methods
//     (callers — CollabService & EnrichmentWorker — decide the fan-out strategy).
//   • URL-encoding, Levenshtein/Similarity, header parsing remain here.
//   • The hardcoded userver::v3_1_rc:: response type is encapsulated inside
//     GeniusGet so no other layer touches it.
// ════════════════════════════════════════════════════════════════════════════

#include "genius_gateway.hpp"
#include "role_mask.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

// ════════════════════════════════════════════════════════════════════════════
// File-private utilities
// ════════════════════════════════════════════════════════════════════════════

namespace {

std::string UrlEncode(std::string_view value) {
    static constexpr char kHex[] = "0123456789ABCDEF";
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

// [BUG-10] Similarity — fixed substring boost guard.
//
// Old code applied a flat 0.90 boost whenever one string contained the other
// as a substring, regardless of length.  A query like "The" would incorrectly
// match "The Weeknd" or "The Beatles" with score 0.90 because "The".find("The")
// succeeds.  Short queries should not get a near-perfect score against long names.
//
// Fix: substring boost is only applied when the shorter string is longer than
// kMinSubstringLen characters.  The base Levenshtein score still applies for
// short queries — they score proportionally to edit distance.
//
// Additionally, the boost is capped by the length ratio so a 5-char substring
// inside a 50-char name never exceeds ratio * 0.90 (avoids false positives on
// common short words like "Jay" inside "Jay-Z").
static constexpr std::size_t kMinSubstringLen = 4;

double Similarity(const std::string& a, const std::string& b) {
    if (a == b) return 1.0;
    const std::size_t maxlen = std::max(a.size(), b.size());
    if (!maxlen) return 1.0;
    double sim = 1.0 - static_cast<double>(Levenshtein(a, b)) /
                       static_cast<double>(maxlen);

    // Substring boost: only when both strings are non-empty AND the shorter
    // one is strictly longer than kMinSubstringLen characters.
    const std::size_t minlen = std::min(a.size(), b.size());
    if (minlen > kMinSubstringLen) {
        const bool a_in_b = (b.find(a) != std::string::npos);
        const bool b_in_a = (a.find(b) != std::string::npos);
        if (a_in_b || b_in_a) {
            // Scale the boost by the length ratio: short substrings inside
            // long names get a proportionally lower boost.
            const double ratio =
                static_cast<double>(minlen) / static_cast<double>(maxlen);
            const double boost = 0.90 * ratio;
            sim = std::max(sim, boost);
        }
    }
    return sim;
}

// Parse an integer from a response header.
// Returns -1 if absent or unparseable.
// The userver::v3_1_rc header type is encapsulated here — no other file
// needs to reference the RC-specific namespace.
template <typename Response>
int ParseIntHeader(const Response& resp, std::string_view name) {
    const auto& headers = resp.headers();
    auto it = headers.find(std::string{name});
    if (it == headers.end()) return -1;
    try { return std::stoi(it->second); } catch (...) { return -1; }
}

template <typename Response>
std::int64_t ParseInt64Header(const Response& resp, std::string_view name) {
    const auto& headers = resp.headers();
    auto it = headers.find(std::string{name});
    if (it == headers.end()) return 0;
    try { return std::stoll(it->second); } catch (...) { return 0; }
}

ArtistRef ParseArtistObject(const formats::json::Value& obj) {
    return {
        obj["id"].As<std::int64_t>(0),
        obj["name"].As<std::string>(""),
        obj["image_url"].As<std::string>(""),
        obj["url"].As<std::string>("")
    };
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

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// Constructor
// ════════════════════════════════════════════════════════════════════════════

GeniusGateway::GeniusGateway(const components::ComponentConfig&  config,
                              const components::ComponentContext& context)
    : ComponentBase(config, context),
      http_client_(
          context.FindComponent<components::HttpClient>().GetHttpClient()),
      genius_token_(config["genius-api-token"].As<std::string>()),
      genius_base_url_(
          config["genius-base-url"].As<std::string>("https://api.genius.com")),
      songs_limit_fg_(config["songs-limit-fg"].As<int>(10)),
      songs_limit_bg_(config["songs-limit-bg"].As<int>(80)),
      match_threshold_(config["match-threshold"].As<double>(0.9)),
      backoff_max_attempts_(config["backoff-max-attempts"].As<int>(4)),
      backoff_base_ms_(
          std::chrono::milliseconds{config["backoff-base-ms"].As<int>(200)}),
      backoff_cap_ms_(
          std::chrono::milliseconds{config["backoff-cap-ms"].As<int>(10000)}),
      pipeline_(
          LaneConfig{
              config["lane-fg-tokens-per-sec"].As<double>(8.0),
              config["lane-fg-burst"].As<int>(8),
              config["lane-fg-max-concurrent"].As<int>(3)
          },
          LaneConfig{
              config["lane-bg-tokens-per-sec"].As<double>(2.0),
              config["lane-bg-burst"].As<int>(2),
              config["lane-bg-max-concurrent"].As<int>(1)
          },
          config["cb-failure-threshold"].As<int>(5),
          std::chrono::seconds{config["cb-open-seconds"].As<int>(30)}
      )
{}

// ════════════════════════════════════════════════════════════════════════════
// GeniusGet — lane-aware resilient HTTP GET
//
// Acquisition order (enforced by ResiliencePipeline::Acquire):
//   1. CircuitBreaker     — fast-fail if upstream is known broken
//   2. CooldownGate       — wait if 429 pause is active
//   3. TokenBucket[lane]  — proactive RPS budget
//   4. LaneSemaphore[lane]— concurrency cap
//   5. RateLimiter        — reactive server-announced remaining quota
// ════════════════════════════════════════════════════════════════════════════

std::string GeniusGateway::GeniusGet(const std::string& url, Lane lane) const {
    const std::string auth = "Bearer " + genius_token_;
    int attempt = 0;

    while (true) {
        // Acquire all 5 gates (parks coroutine as needed; never blocks OS thread).
        auto guard = pipeline_.Acquire(lane);

        try {
            const auto resp = http_client_.CreateRequest()
                                  .get(url)
                                  .headers({{"Authorization", auth}})
                                  .timeout(std::chrono::seconds{5})
                                  .retry(0)
                                  .perform();
            const int status = resp->status_code();
            const int remaining  = ParseIntHeader(*resp, "X-RateLimit-Remaining");
            const auto reset_ts  = ParseInt64Header(*resp, "X-RateLimit-Reset");

            // Always update resilience state from the response.
            pipeline_.OnResponse(status, remaining, reset_ts);

            if (status == 429) {
                // CooldownGate was activated inside OnResponse; sleep here.
                const auto wait_secs = [&]() -> std::int64_t {
                    using SC = std::chrono::system_clock;
                    const auto now_unix = static_cast<std::int64_t>(
                        std::chrono::duration_cast<std::chrono::seconds>(
                            SC::now().time_since_epoch()).count());
                    return (reset_ts > now_unix) ? (reset_ts - now_unix + 1) : 60;
                }();
                LOG_WARNING() << "[GW] 429 on " << url
                              << " — sleeping " << wait_secs << "s";
                engine::InterruptibleSleepFor(std::chrono::seconds{wait_secs});
                // guard destructs here → semaphore slot released for next attempt.
                ++attempt;
                if (attempt >= backoff_max_attempts_)
                    throw GeniusHttpError{429, "429 rate limit exhausted retries"};
                continue;
            }

            if (status >= 200 && status < 300) return resp->body();

            // 4xx (not 429): non-retryable.
            if (status >= 400 && status < 500)
                throw GeniusHttpError{status, "HTTP " + std::to_string(status)};

            // 5xx — fall through to backoff below.
            LOG_WARNING() << "[GW] HTTP " << status
                          << " attempt=" << attempt << " url=" << url;

        } catch (const GeniusHttpError&) {
            throw;
        } catch (const std::exception& ex) {
            pipeline_.OnNetworkError();
            LOG_WARNING() << "[GW] network error attempt=" << attempt
                          << ": " << ex.what();
        }

        ++attempt;
        if (attempt >= backoff_max_attempts_) {
            pipeline_.OnNetworkError();
            throw GeniusHttpError{502, "exhausted retries: " + url};
        }
        engine::InterruptibleSleepFor(
            ExponentialBackoff(attempt, backoff_base_ms_, backoff_cap_ms_));
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

std::vector<Candidate>
GeniusGateway::ResolveCandidates(const std::string& query) const {
    const std::string body =
        GeniusGet(genius_base_url_ + "/search?q=" + UrlEncode(query),
                  Lane::Foreground);
    const auto json  = formats::json::FromString(body);
    const auto& hits = json["response"]["hits"];

    std::vector<Candidate> out;
    std::unordered_set<std::int64_t> seen;
    const std::string q = NormalizeStr(query);

    if (hits.IsArray()) {
        for (const auto& hit : hits) {
            const auto& p  = hit["result"]["primary_artist"];
            const auto  id = p["id"].As<std::int64_t>(0);
            if (!id || seen.count(id)) continue;
            seen.insert(id);
            Candidate c;
            c.id    = id;
            c.name  = p["name"].As<std::string>("");
            c.image = p["image_url"].As<std::string>("");
            c.url   = p["url"].As<std::string>("");
            c.score = Similarity(q, NormalizeStr(c.name));
            out.push_back(std::move(c));
        }
    }
    std::sort(out.begin(), out.end(),
              [](const Candidate& a, const Candidate& b) {
                  return a.score > b.score;
              });
    if (out.size() > 8) out.resize(8);
    return out;
}

std::optional<ArtistRef>
GeniusGateway::FetchArtistById(std::int64_t id, Lane lane) const {
    try {
        const std::string body = GeniusGet(
            genius_base_url_ + "/artists/" + std::to_string(id), lane);
        const auto& a = formats::json::FromString(body)["response"]["artist"];
        if (!a.IsObject()) return std::nullopt;
        return ArtistRef{
            a["id"].As<std::int64_t>(id),
            a["name"].As<std::string>(""),
            a["image_url"].As<std::string>(""),
            a["url"].As<std::string>("")
        };
    } catch (const std::exception& ex) {
        LOG_WARNING() << "[GW] FetchArtistById(" << id << "): " << ex.what();
        return std::nullopt;
    }
}

std::vector<std::int64_t>
GeniusGateway::FetchSongList(std::int64_t artist_id,
                              int limit, Lane lane) const {
    const std::string url =
        genius_base_url_ + "/artists/" + std::to_string(artist_id) +
        "/songs?sort=popularity&per_page=" + std::to_string(limit);

    const auto json      = formats::json::FromString(GeniusGet(url, lane));
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

std::optional<SongRecord>
GeniusGateway::FetchSongDetail(std::int64_t song_id, Lane lane) const {
    try {
        const std::string url =
            genius_base_url_ + "/songs/" + std::to_string(song_id);
        const auto json  = formats::json::FromString(GeniusGet(url, lane));
        const auto& song = json["response"]["song"];
        if (!song.IsObject()) return std::nullopt;

        SongRecord rec;
        rec.id    = song_id;
        rec.title = song["title"].As<std::string>("");
        if (rec.title.empty())
            rec.title = song["full_title"].As<std::string>("");

        const auto push = [&](const formats::json::Value& arr, const char* role) {
            for (const auto& a : ParseArtistArray(arr))
                if (a.id) rec.credits.push_back({a, role});
        };
        if (song.HasMember("primary_artist")) {
            auto pa = ParseArtistObject(song["primary_artist"]);
            if (pa.id) rec.credits.push_back({std::move(pa), "primary"});
        }
        push(song["producer_artists"], "producer");
        push(song["writer_artists"],   "writer");
        push(song["featured_artists"], "featured");
        return rec;

    } catch (const std::exception& ex) {
        LOG_WARNING() << "[GW] FetchSongDetail(" << song_id
                      << "): " << ex.what();
        return std::nullopt;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Config schema
// ════════════════════════════════════════════════════════════════════════════

yaml_config::Schema GeniusGateway::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(R"(
type: object
description: Network-only Genius API client with lane-aware resilience
additionalProperties: false
properties:
    genius-api-token:
        type: string
        description: Genius Client Access Token
    genius-base-url:
        type: string
        description: Base URL
        defaultDescription: https://api.genius.com
    songs-limit-fg:
        type: integer
        description: Songs per FG request
        defaultDescription: '10'
    songs-limit-bg:
        type: integer
        description: Songs per BG deep scan
        defaultDescription: '80'
    match-threshold:
        type: number
        description: Fuzzy match threshold
        defaultDescription: '0.9'
    backoff-max-attempts:
        type: integer
        defaultDescription: '4'
    backoff-base-ms:
        type: integer
        defaultDescription: '200'
    backoff-cap-ms:
        type: integer
        defaultDescription: '10000'
    lane-fg-tokens-per-sec:
        type: number
        defaultDescription: '8.0'
    lane-fg-burst:
        type: integer
        defaultDescription: '8'
    lane-fg-max-concurrent:
        type: integer
        defaultDescription: '3'
    lane-bg-tokens-per-sec:
        type: number
        defaultDescription: '2.0'
    lane-bg-burst:
        type: integer
        defaultDescription: '2'
    lane-bg-max-concurrent:
        type: integer
        defaultDescription: '1'
    cb-failure-threshold:
        type: integer
        defaultDescription: '5'
    cb-open-seconds:
        type: integer
        defaultDescription: '30'
)");
}

} // namespace six_feat
