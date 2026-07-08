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

#include "genius/genius_gateway.hpp"
#include "core/request_id.hpp"
#include "domain/role_mask.hpp"

#include <algorithm>
#include <array>
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
#include <userver/components/statistics_storage.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/cancel.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/statistics/writer.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

// ════════════════════════════════════════════════════════════════════════════
// File-private utilities
// ════════════════════════════════════════════════════════════════════════════

namespace {

// Max fuzzy-search candidates kept after sorting by similarity score, before
// returning them to the caller (CollabService trims further for display).
constexpr std::size_t kMaxSearchCandidates = 8;

// Validates numeric static_config.yaml values at startup so an invalid
// value (0, negative, unparseable typo) fails loudly here instead of
// corrupting resilience-pipeline state (TokenBucket, LaneSemaphore,
// CircuitBreaker) further down the line.
int RequirePositive(std::string_view param, int value) {
    if (value <= 0) {
        throw std::runtime_error(
            "genius-gateway: " + std::string(param) +
            " must be a positive integer, got " + std::to_string(value));
    }
    return value;
}

double RequirePositive(std::string_view param, double value) {
    if (!(value > 0.0)) {
        throw std::runtime_error(
            "genius-gateway: " + std::string(param) +
            " must be a positive number, got " + std::to_string(value));
    }
    return value;
}

// [IDEA-27] Defense-in-depth for the "access_token never hits the logs"
// requirement: the OAuth access_token is only ever sent as a Bearer
// Authorization header (never a query parameter, see GeniusGet below) and
// that header is never logged — but every url= log line still goes through
// this redactor so a future change that accidentally puts a token/secret in
// the query string fails safe instead of leaking it.
std::string RedactUrl(std::string_view url) {
    static constexpr std::array<std::string_view, 4> kSensitiveParams{
        "access_token", "token", "client_secret", "authorization"};

    const auto qpos = url.find('?');
    if (qpos == std::string_view::npos) return std::string{url};

    std::string out{url.substr(0, qpos + 1)};
    std::string_view query = url.substr(qpos + 1);
    bool first = true;
    while (!query.empty()) {
        const auto amp   = query.find('&');
        const auto piece = query.substr(0, amp);
        // piece.find('=') here trips a GCC 11 -Wstringop-overread false
        // positive (memchr bound of SIZE_MAX) once inlined alongside the
        // sensitive ? "***" : ... branch below; an iterator scan sidesteps
        // the string_view::find() code path the warning fires on.
        const auto eq_it = std::find(piece.begin(), piece.end(), '=');
        const auto eq    = eq_it == piece.end()
                                ? std::string_view::npos
                                : static_cast<std::string_view::size_type>(eq_it - piece.begin());
        const auto key   = piece.substr(0, eq);

        const bool sensitive = std::find(kSensitiveParams.begin(),
                                          kSensitiveParams.end(),
                                          key) != kSensitiveParams.end();
        if (!first) out += '&';
        first = false;
        out += std::string{key};
        out += '=';
        out += sensitive ? "***"
                          : std::string{eq == std::string_view::npos
                                            ? std::string_view{}
                                            : piece.substr(eq + 1)};

        if (amp == std::string_view::npos) break;
        query = query.substr(amp + 1);
    }
    return out;
}

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
      genius_base_url_(
          config["genius-base-url"].As<std::string>("https://api.genius.com")),
      songs_limit_fg_(RequirePositive(
          "songs-limit-fg", config["songs-limit-fg"].As<int>(40))),
      songs_limit_bg_(RequirePositive(
          "songs-limit-bg", config["songs-limit-bg"].As<int>(80))),
      match_threshold_(config["match-threshold"].As<double>(0.9)),
      backoff_max_attempts_(RequirePositive(
          "backoff-max-attempts", config["backoff-max-attempts"].As<int>(4))),
      backoff_base_ms_(std::chrono::milliseconds{RequirePositive(
          "backoff-base-ms", config["backoff-base-ms"].As<int>(200))}),
      backoff_cap_ms_(std::chrono::milliseconds{RequirePositive(
          "backoff-cap-ms", config["backoff-cap-ms"].As<int>(10000))}),
      pipeline_(
          LaneConfig{
              RequirePositive("lane-fg-tokens-per-sec",
                              config["lane-fg-tokens-per-sec"].As<double>(8.0)),
              RequirePositive("lane-fg-burst",
                              config["lane-fg-burst"].As<int>(8)),
              RequirePositive("lane-fg-max-concurrent",
                              config["lane-fg-max-concurrent"].As<int>(3))
          },
          LaneConfig{
              RequirePositive("lane-bg-tokens-per-sec",
                              config["lane-bg-tokens-per-sec"].As<double>(2.0)),
              RequirePositive("lane-bg-burst",
                              config["lane-bg-burst"].As<int>(2)),
              RequirePositive("lane-bg-max-concurrent",
                              config["lane-bg-max-concurrent"].As<int>(1))
          },
          RequirePositive("cb-failure-threshold",
                          config["cb-failure-threshold"].As<int>(5)),
          std::chrono::seconds{RequirePositive(
              "cb-open-seconds", config["cb-open-seconds"].As<int>(30))}
      )
{
    // [IDEA-27] Expose CB state / lane token+slot availability on the
    // internal metrics endpoint (see static_config.yaml handler-server-monitor).
    auto& storage =
        context.FindComponent<components::StatisticsStorage>().GetStorage();
    statistics_holder_ = storage.RegisterWriter(
        "genius-gateway",
        [this](utils::statistics::Writer& writer) { ExtendStatistics(writer); });
}

GeniusGateway::~GeniusGateway() {
    statistics_holder_.Unregister();
}

void GeniusGateway::ExtendStatistics(utils::statistics::Writer& writer) const {
    const auto state = pipeline_.CbState();
    writer["circuit_breaker"]["state"]     = static_cast<int>(state);
    writer["circuit_breaker"]["closed"]    =
        state == CircuitBreaker::State::Closed ? 1 : 0;
    writer["circuit_breaker"]["open"]      =
        state == CircuitBreaker::State::Open ? 1 : 0;
    writer["circuit_breaker"]["half_open"] =
        state == CircuitBreaker::State::HalfOpen ? 1 : 0;

    writer["lane"]["foreground"]["tokens_available"] = pipeline_.FgTokensAvailable();
    writer["lane"]["foreground"]["slots_available"]  = pipeline_.FgSlotsAvailable();
    writer["lane"]["background"]["tokens_available"] = pipeline_.BgTokensAvailable();
    writer["lane"]["background"]["slots_available"]  = pipeline_.BgSlotsAvailable();
}

// ════════════════════════════════════════════════════════════════════════════
// GeniusGet — lane-aware resilient HTTP GET
//
// Acquisition order (enforced by ResiliencePipeline::Acquire):
//   1. CircuitBreaker     — fast-fail if upstream is known broken
//   2. CooldownGate       — wait if 429 pause is active
//   3. TokenBucket[lane]  — proactive RPS budget
//   4. LaneSemaphore[lane]— concurrency cap
//   5. RateLimiter        — reactive server-announced remaining quota
//
// [No more server-level token] Every call now requires a per-user OAuth
// token obtained via /auth/login. There is no config-supplied fallback
// token anymore — an empty user_token is a programming error upstream
// (the handler should have rejected the request before reaching here),
// so it is surfaced as a clear 401 rather than silently using a shared
// credential that no longer exists.
// ════════════════════════════════════════════════════════════════════════════

std::string GeniusGateway::GeniusGet(const std::string& url,
                                      Lane               lane,
                                      const std::string& user_token) const {
    if (user_token.empty())
        throw GeniusHttpError{401, "no Genius session token — user must log in"};
    const std::string auth = "Bearer " + user_token;
    const std::string& request_id = CurrentRequestId();
    int attempt = 0;
    int last_5xx_status = 502;

    while (true) {
        // Acquire all 5 gates (parks coroutine as needed; never blocks OS thread).
        auto guard = pipeline_.Acquire(lane);
        // Set wherever this attempt's failure has already been counted against
        // the CircuitBreaker (network-error catch → OnNetworkError, or the 5xx
        // branch → RecordFailure inside OnResponse), so the exhausted-retries
        // path below doesn't double-count it with a second OnNetworkError().
        bool failure_already_recorded_for_this_attempt = false;

        try {
            const auto resp = http_client_.CreateRequest()
                                  .get(url)
                                  .headers({{"Authorization", auth},
                                            {"X-Request-Id", request_id}})
                                  .timeout(std::chrono::seconds{5})
                                  .retry(0)
                                  .perform();
            const int status = resp->status_code();
            const int remaining  = ParseIntHeader(*resp, "X-RateLimit-Remaining");
            const auto reset_ts  = ParseInt64Header(*resp, "X-RateLimit-Reset");

            // Always update resilience state from the response.
            pipeline_.OnResponse(guard, status, remaining, reset_ts);

            if (status == 429) {
                // CooldownGate was activated inside OnResponse; sleep here.
                const auto wait_secs = [&]() -> std::int64_t {
                    using SC = std::chrono::system_clock;
                    const auto now_unix = static_cast<std::int64_t>(
                        std::chrono::duration_cast<std::chrono::seconds>(
                            SC::now().time_since_epoch()).count());
                    return (reset_ts > now_unix) ? (reset_ts - now_unix + 1) : 60;
                }();
                LOG_WARNING() << "[GW] request_id=" << request_id
                              << " 429 on " << RedactUrl(url)
                              << " — sleeping " << wait_secs << "s";
                // Release the LaneSemaphore slot (RateLimiter slot is already
                // settled by OnResponse above) before the long cooldown sleep,
                // so other FG/BG requests aren't starved of this lane's
                // concurrency slot while we wait. Re-acquired fresh (all 5
                // gates, via pipeline_.Acquire) at the top of the loop below.
                guard = ResiliencePipeline::Guard{};
                engine::InterruptibleSleepFor(std::chrono::seconds{wait_secs});
                ++attempt;
                if (attempt >= backoff_max_attempts_) {
                    // 429 handling is entirely internal to this gateway — the
                    // caller (main/enrichment, via GeniusGatewayClient) must
                    // never see a raw 429 and re-implement Genius backoff
                    // itself. Once our own cooldown+retry budget is
                    // exhausted, surface the same 503 ("Genius unavailable")
                    // used for CB-open, so every exhaustion path looks
                    // identical to callers.
                    LOG_ERROR() << "[GW] request_id=" << request_id
                                << " 429 retries exhausted on " << RedactUrl(url);
                    throw GeniusHttpError{503, "429 rate limit exhausted retries"};
                }
                continue;
            }

            if (status >= 200 && status < 300) return resp->body();

            // 4xx (not 429): non-retryable.
            if (status >= 400 && status < 500)
                throw GeniusHttpError{status, "HTTP " + std::to_string(status)};

            // 5xx — fall through to backoff below. OnResponse() above already
            // called cb_.RecordFailure() for this status, so this attempt's
            // failure is already counted.
            last_5xx_status = status;
            failure_already_recorded_for_this_attempt = true;
            LOG_WARNING() << "[GW] request_id=" << request_id
                          << " HTTP " << status
                          << " attempt=" << attempt
                          << " url=" << RedactUrl(url);

        } catch (const GeniusHttpError&) {
            throw;
        } catch (const std::exception& ex) {
            // [FIX] A client disconnecting / aborting its HTTP request (e.g. the
            // frontend's AbortController firing on a new keystroke — see ТЗ-4)
            // propagates as task cancellation through userver's deadline
            // machinery. That is NOT evidence Genius itself is unhealthy, but
            // unconditionally calling OnNetworkError() here treats it exactly
            // like a real upstream outage and can trip the circuit breaker
            // (default threshold 5) off a single distracted user — punishing
            // every other concurrent request with 502/503 for cb-open-seconds.
            //
            // engine::current_task::ShouldCancel() is true precisely when this
            // coroutine's own task was cancelled (client gone / deadline hit),
            // as opposed to the HTTP client genuinely failing to reach Genius.
            // In that case we propagate the cancellation immediately instead of
            // retrying or poisoning the circuit breaker.
            if (engine::current_task::ShouldCancel()) {
                LOG_DEBUG() << "[GW] request_id=" << request_id
                            << " request cancelled (client gone / deadline) "
                               "for " << RedactUrl(url)
                            << " — not counted as upstream failure";
                throw GeniusHttpError{499, "client request cancelled"};
            }
            pipeline_.OnNetworkError();
            failure_already_recorded_for_this_attempt = true;
            LOG_WARNING() << "[GW] request_id=" << request_id
                          << " network error attempt=" << attempt
                          << ": " << ex.what();
        }

        ++attempt;
        if (attempt >= backoff_max_attempts_) {
            // Only count this as a fresh failure if the current attempt's
            // outcome (network error or 5xx) hasn't already been recorded
            // above — otherwise the CircuitBreaker would see one failed
            // request as two consecutive_failures_ increments.
            if (!failure_already_recorded_for_this_attempt) {
                pipeline_.OnNetworkError();
            }
            throw GeniusHttpError{last_5xx_status, "exhausted retries: " + url};
        }
        const auto backoff =
            ExponentialBackoff(attempt, backoff_base_ms_, backoff_cap_ms_);
        LOG_INFO() << "[GW] request_id=" << request_id
                   << " retrying attempt=" << attempt
                   << " in " << backoff.count() << "ms";
        engine::InterruptibleSleepFor(backoff);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

std::vector<Candidate>
GeniusGateway::ResolveCandidates(const std::string& query,
                                  const std::string& user_token) const {
    const std::string body =
        GeniusGet(genius_base_url_ + "/search?q=" + UrlEncode(query),
                  Lane::Foreground, user_token);
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
    if (out.size() > kMaxSearchCandidates) out.resize(kMaxSearchCandidates);
    return out;
}

std::optional<ArtistRef>
GeniusGateway::FetchArtistById(std::int64_t id, Lane lane,
                                const std::string& user_token) const {
    try {
        const std::string body = GeniusGet(
            genius_base_url_ + "/artists/" + std::to_string(id), lane,
            user_token);
        const auto& a = formats::json::FromString(body)["response"]["artist"];
        if (!a.IsObject()) return std::nullopt;
        return ArtistRef{
            a["id"].As<std::int64_t>(id),
            a["name"].As<std::string>(""),
            a["image_url"].As<std::string>(""),
            a["url"].As<std::string>("")
        };
    } catch (const GeniusHttpError& e) {
        if (e.status_code == 401) throw;
        LOG_WARNING() << "[GW] FetchArtistById(" << id << "): " << e.what();
        return std::nullopt;
    } catch (const std::exception& ex) {
        LOG_WARNING() << "[GW] FetchArtistById(" << id << "): " << ex.what();
        return std::nullopt;
    }
}

std::vector<std::int64_t>
GeniusGateway::FetchSongList(std::int64_t artist_id,
                              int limit, Lane lane,
                              const std::string& user_token) const {
    const std::string url =
        genius_base_url_ + "/artists/" + std::to_string(artist_id) +
        "/songs?sort=popularity&per_page=" + std::to_string(limit);

    const auto json      = formats::json::FromString(GeniusGet(url, lane, user_token));
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
GeniusGateway::FetchSongDetail(std::int64_t song_id, Lane lane,
                                const std::string& user_token) const {
    try {
        const std::string url =
            genius_base_url_ + "/songs/" + std::to_string(song_id);
        const auto json  = formats::json::FromString(GeniusGet(url, lane, user_token));
        const auto& song = json["response"]["song"];
        if (!song.IsObject()) return std::nullopt;

        SongRecord rec;
        rec.id    = song_id;
        rec.title = song["title"].As<std::string>("");
        if (rec.title.empty())
            rec.title = song["full_title"].As<std::string>("");
        // Popularity signal for ranking "top tracks" client-side (IDEA-17).
        // stats.pageviews is the field Genius' song-detail response actually
        // carries; absent for songs the API hasn't tallied views for, in
        // which case this stays 0.
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
        push(song["writer_artists"],   "writer");
        push(song["featured_artists"], "featured");
        return rec;

    } catch (const GeniusHttpError& e) {
        if (e.status_code == 401) throw;
        LOG_WARNING() << "[GW] FetchSongDetail(" << song_id
                      << "): " << e.what();
        return std::nullopt;
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
    genius-base-url:
        type: string
        description: Base URL
        defaultDescription: https://api.genius.com
    songs-limit-fg:
        type: integer
        description: Songs per FG request
        defaultDescription: '40'
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
        description: Maximum retry attempts for transient failures
        defaultDescription: '4'
    backoff-base-ms:
        type: integer
        description: Initial backoff interval in milliseconds
        defaultDescription: '200'
    backoff-cap-ms:
        type: integer
        description: Maximum backoff interval in milliseconds
        defaultDescription: '10000'
    lane-fg-tokens-per-sec:
        type: number
        description: Rate limit for foreground requests in tokens per second
        defaultDescription: '8.0'
    lane-fg-burst:
        type: integer
        description: Token bucket burst size for foreground lane
        defaultDescription: '8'
    lane-fg-max-concurrent:
        type: integer
        description: Maximum concurrent foreground requests
        defaultDescription: '3'
    lane-bg-tokens-per-sec:
        type: number
        description: Rate limit for background requests in tokens per second
        defaultDescription: '2.0'
    lane-bg-burst:
        type: integer
        description: Token bucket burst size for background lane
        defaultDescription: '2'
    lane-bg-max-concurrent:
        type: integer
        description: Maximum concurrent background requests
        defaultDescription: '1'
    cb-failure-threshold:
        type: integer
        description: Number of failures before circuit opens
        defaultDescription: '5'
    cb-open-seconds:
        type: integer
        description: Duration to keep circuit open in seconds
        defaultDescription: '30'
)");
}

} // namespace six_feat
