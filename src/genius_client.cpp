// ════════════════════════════════════════════════════════════════════════════
// genius_client.cpp  —  iteration 5
//
// Рефакторинг отказоустойчивости:
//
//  [1] CONCURRENCY LIMITER
//      GeniusGet() захватывает SemaphoreLock перед отправкой запроса.
//      Семафор инициализируется значением `max-concurrent-requests` (дефолт 3).
//      Лишние корутины паркуются в очереди планировщика userver, не занимая поток.
//
//  [2] SLOT-ORIENTED RATE LIMITER
//      RateLimiter::AcquireSlot() атомарно декрементирует счётчик слотов через
//      CAS-петлю. Если доступных слотов нет — корутина встаёт в ConditionVariable.
//      Update() пополняет счётчик из X-RateLimit-Remaining и делает NotifyAll.
//
//  [3] THUNDERING HERD PROTECTION
//      CooldownGate::Activate() устанавливает глобальный дедлайн паузы при 429.
//      Все корутины, вызывающие WaitForCooldown() в начале GeniusGet(),
//      блокируются единой ConditionVariable до истечения дедлайна.
//      Первая корутина, поймавшая 429, активирует ворота и засыпает сама.
//      После пробуждения делает NotifyAll — остальные корутины стартуют
//      упорядоченно, уже через семафор (не все разом).
//
//  Все примитивы — coroutine-safe: engine::Mutex, engine::ConditionVariable,
//  engine::Semaphore, engine::InterruptibleSleepFor.
// ════════════════════════════════════════════════════════════════════════════

#include "genius_client.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/condition_variable.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/semaphore.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/logging/log.hpp>
#include <userver/utils/async.hpp>
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

std::string NormalizeName(std::string_view value) {
    std::string out;
    out.reserve(value.size());
    bool prev = false;
    for (unsigned char c : value) {
        if (std::isspace(c)) {
            if (!out.empty() && !prev) out.push_back(' ');
            prev = true;
        } else {
            out.push_back(static_cast<char>(std::tolower(c)));
            prev = false;
        }
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
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

double Similarity(const std::string& a, const std::string& b) {
    if (a == b) return 1.0;
    const std::size_t maxlen = std::max(a.size(), b.size());
    if (!maxlen) return 1.0;
    double sim = 1.0 - static_cast<double>(Levenshtein(a, b)) /
                       static_cast<double>(maxlen);
    if (!a.empty() && !b.empty() &&
        (a.find(b) != std::string::npos || b.find(a) != std::string::npos))
        sim = std::max(sim, 0.90);
    return sim;
}

std::chrono::milliseconds ExponentialBackoff(int attempt,
                                             std::chrono::milliseconds base,
                                             std::chrono::milliseconds cap) {
    // Быстрый xorshift-based PRNG — thread_local, не требует мьютекса.
    thread_local std::uint64_t tl_seed = [] {
        const auto tid = std::hash<std::thread::id>{}(std::this_thread::get_id());
        const auto ts  = static_cast<std::uint64_t>(
            std::chrono::steady_clock::now().time_since_epoch().count());
        return tid ^ ts;
    }();
    tl_seed = tl_seed * 6364136223846793005ULL + 1442695040888963407ULL;
    const std::int64_t jitter =
        (base.count() > 0)
            ? static_cast<std::int64_t>(
                  tl_seed % static_cast<std::uint64_t>(base.count()))
            : 0;
    const int safe    = std::min(attempt, 10);
    long long raw     = base.count() * (1LL << safe) + jitter;
    long long capped  = std::min(raw, static_cast<long long>(cap.count()));
    return std::chrono::milliseconds{capped};
}

int ParseIntHeader(const userver::v3_1_rc::clients::http::Response& resp,
                   std::string_view header_name) {
    const auto& headers = resp.headers();
    auto it = headers.find(std::string{header_name});
    if (it == headers.end()) return -1;
    try { return std::stoi(it->second); } catch (...) { return -1; }
}

std::int64_t ParseInt64Header(const userver::v3_1_rc::clients::http::Response& resp,
                              std::string_view header_name) {
    const auto& headers = resp.headers();
    auto it = headers.find(std::string{header_name});
    if (it == headers.end()) return 0;
    try { return std::stoll(it->second); } catch (...) { return 0; }
}

ArtistRef ParseArtistObject(const formats::json::Value& obj) {
    return {obj["id"].As<std::int64_t>(0), obj["name"].As<std::string>(""),
            obj["image_url"].As<std::string>(""), obj["url"].As<std::string>("")};
}

std::vector<ArtistRef> ParseArtistArray(const formats::json::Value& arr) {
    if (!arr.IsArray()) return {};
    std::vector<ArtistRef> out;
    out.reserve(arr.GetSize());
    for (const auto& a : arr) {
        auto r = ParseArtistObject(a);
        if (r.id) out.push_back(std::move(r));
    }
    return out;
}

} // namespace

// ════════════════════════════════════════════════════════════════════════════
// CooldownGate
// ════════════════════════════════════════════════════════════════════════════

void CooldownGate::Activate(TimePoint deadline) {
    // Захватываем engine::Mutex — корутина паркуется, поток свободен.
    std::unique_lock lock(mu_);

    if (active_ && deadline_ >= deadline) {
        // Уже активен с более поздним или равным дедлайном — ничего не делаем.
        return;
    }

    // Либо не активен, либо новый дедлайн позже текущего — обновляем.
    deadline_ = deadline;
    active_   = true;
    LOG_WARNING() << "[CooldownGate] Activated until "
                  << std::chrono::duration_cast<std::chrono::seconds>(
                         deadline.time_since_epoch()).count()
                  << " (unix-monotonic)";
    // Не нотифицируем здесь — будим всех ПОСЛЕ того, как сами проспим.
}

void CooldownGate::WaitForCooldown() {
    std::unique_lock lock(mu_);

    if (!active_) return;  // быстрый путь — ворота закрыты

    const auto deadline = deadline_;  // копируем под мьютексом

    LOG_DEBUG() << "[CooldownGate] Coroutine waiting for cooldown end";

    // engine::ConditionVariable::WaitUntil() паркует корутину, не блокируя поток.
    // Предикат: выход, если ворота закрыты или дедлайн уже другой (обновился).
    const auto status = cv_.WaitUntil(lock, deadline, [this, deadline] {
        return !active_ || deadline_ != deadline;
    });

    // Если WaitUntil вернулся по дедлайну (не по нотификации) —
    // мы сами деактивируем ворота и будим всех остальных.
    if (active_ && deadline_ == deadline) {
        active_ = false;
        LOG_INFO() << "[CooldownGate] Cooldown expired, releasing waiters";
        lock.unlock();
        cv_.NotifyAll();  // broadcast — все ждущие корутины продолжают работу
    }
}

bool CooldownGate::IsActive() const {
    std::unique_lock lock(mu_);
    return active_ && (CooldownGate::Clock::now() < deadline_);
}

// ════════════════════════════════════════════════════════════════════════════
// RateLimiter — slot-oriented
// ════════════════════════════════════════════════════════════════════════════

void RateLimiter::Update(int remaining, std::int64_t reset_unix) {
    std::unique_lock lock(mu_);

    const bool slots_increased =
        (remaining >= 0) && (remaining > available_slots_);

    if (remaining >= 0) {
        remaining_       = remaining;
        available_slots_ = remaining;  // синхронизируем счётчик слотов
    }
    if (reset_unix > 0) {
        reset_unix_ = reset_unix;
    }

    if (slots_increased) {
        // Новые слоты появились — будим всех, кто ждал.
        lock.unlock();
        cv_.NotifyAll();
        LOG_DEBUG() << "[RateLimiter] Updated slots=" << remaining;
    }
}

void RateLimiter::AcquireSlot() {
    // Если API ещё не вернул ни одного заголовка — пропускаем без ожидания.
    // Это нормально в начале работы: семафор уже ограничивает конкурентность.
    {
        std::unique_lock lock(mu_);
        if (available_slots_ < 0) return;  // данных нет — не ограничиваем
    }

    WaitAndDecrement();
}

void RateLimiter::ReleaseSlot() {
    std::unique_lock lock(mu_);
    if (available_slots_ < 0) return;  // не инициализирован — ничего не делаем

    ++available_slots_;
    // Будим одну ждущую корутину: слот стал доступен.
    lock.unlock();
    cv_.NotifyOne();
    LOG_DEBUG() << "[RateLimiter] Slot released, available=" << available_slots_;
}

int RateLimiter::Remaining() const {
    std::unique_lock lock(mu_);
    return remaining_;
}

void RateLimiter::WaitAndDecrement() {
    std::unique_lock lock(mu_);

    // Ждём, пока доступных слотов станет больше kMinRemaining.
    // engine::ConditionVariable::Wait() — корутина паркуется, поток свободен.
    cv_.Wait(lock, [this] {
        return available_slots_ < 0 ||           // нет данных — пропускаем
               available_slots_ > kMinRemaining; // есть свободные слоты
    });

    if (available_slots_ < 0) return;  // нет данных — выходим без декремента

    // Атомарно захватываем слот.
    --available_slots_;

    LOG_DEBUG() << "[RateLimiter] Slot acquired, available=" << available_slots_;
}

// ════════════════════════════════════════════════════════════════════════════
// CircuitBreaker (без изменений)
// ════════════════════════════════════════════════════════════════════════════

bool CircuitBreaker::AllowRequest() {
    const State s = state_.load(std::memory_order_acquire);
    if (s == State::Closed) return true;
    if (s == State::Open) {
        std::lock_guard lock(mu_);
        if (state_.load(std::memory_order_relaxed) != State::Open)
            return state_.load(std::memory_order_relaxed) == State::HalfOpen;
        if (std::chrono::steady_clock::now() - trip_time_ >= open_duration_) {
            LOG_INFO() << "[CB] Open→HalfOpen";
            state_.store(State::HalfOpen, std::memory_order_release);
            return true;
        }
        return false;
    }
    return true; // HalfOpen
}

void CircuitBreaker::RecordSuccess() {
    const State s = state_.load(std::memory_order_acquire);
    if (s == State::Closed) {
        std::lock_guard lock(mu_);
        consecutive_failures_ = 0;
        return;
    }
    if (s == State::HalfOpen) {
        std::lock_guard lock(mu_);
        if (state_.load(std::memory_order_relaxed) == State::HalfOpen)
            Reset();
    }
}

void CircuitBreaker::RecordFailure() {
    std::lock_guard lock(mu_);
    ++consecutive_failures_;
    const State s = state_.load(std::memory_order_relaxed);
    if (s == State::HalfOpen) { Trip(); return; }
    if (s == State::Closed && consecutive_failures_ >= failure_threshold_)
        Trip();
}

CircuitBreaker::State CircuitBreaker::CurrentState() const {
    return state_.load(std::memory_order_acquire);
}

void CircuitBreaker::Trip() {
    trip_time_ = std::chrono::steady_clock::now();
    state_.store(State::Open, std::memory_order_release);
    LOG_ERROR() << "[CB] TRIPPED (failures=" << consecutive_failures_ << ")";
}

void CircuitBreaker::Reset() {
    consecutive_failures_ = 0;
    state_.store(State::Closed, std::memory_order_release);
    LOG_INFO() << "[CB] HalfOpen→Closed";
}

// ════════════════════════════════════════════════════════════════════════════
// GeniusClient — constructor and config
// ════════════════════════════════════════════════════════════════════════════

GeniusClient::GeniusClient(const components::ComponentConfig&  config,
                           const components::ComponentContext& context)
    : ComponentBase(config, context),
      http_client_(
          context.FindComponent<components::HttpClient>().GetHttpClient()),
      genius_token_(config["genius-api-token"].As<std::string>()),
      genius_base_url_(
          config["genius-base-url"].As<std::string>("https://api.genius.com")),
      songs_limit_(config["songs-limit"].As<int>(15)),
      match_threshold_(config["match-threshold"].As<double>(0.9)),
      circuit_breaker_(
          config["cb-failure-threshold"].As<int>(5),
          std::chrono::seconds{config["cb-open-seconds"].As<int>(30)}),
      backoff_max_attempts_(config["backoff-max-attempts"].As<int>(4)),
      backoff_base_ms_(
          std::chrono::milliseconds{config["backoff-base-ms"].As<int>(200)}),
      backoff_cap_ms_(
          std::chrono::milliseconds{config["backoff-cap-ms"].As<int>(10000)}),
      // [1] Semaphore инициализируется из конфига.
      // engine::Semaphore принимает max_simultaneous_locks в конструкторе.
      connection_semaphore_(
          static_cast<std::size_t>(
              config["max-concurrent-requests"].As<int>(3))),
      artist_cache_(
          static_cast<std::size_t>(config["cache-max-artists"].As<int>(512)),
          std::chrono::seconds{config["cache-ttl-seconds"].As<int>(1800)}) {}

yaml_config::Schema GeniusClient::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(R"(
type: object
description: Shared Genius API client with LRU cache and resilience
additionalProperties: false
properties:
    genius-api-token:
        type: string
        description: Genius Client Access Token
    genius-base-url:
        type: string
        description: Base URL of the Genius API
        defaultDescription: https://api.genius.com
    songs-limit:
        type: integer
        description: Songs to scan per artist
        defaultDescription: '15'
    match-threshold:
        type: number
        description: Fuzzy match threshold 0..1
        defaultDescription: '0.9'
    cache-max-artists:
        type: integer
        description: LRU capacity in entries
        defaultDescription: '512'
    cache-ttl-seconds:
        type: integer
        description: Entry TTL in seconds
        defaultDescription: '1800'
    cb-failure-threshold:
        type: integer
        description: Consecutive failures before CB trips
        defaultDescription: '5'
    cb-open-seconds:
        type: integer
        description: Seconds CB stays Open before HalfOpen probe
        defaultDescription: '30'
    backoff-max-attempts:
        type: integer
        description: Max retry attempts for 5xx/network errors
        defaultDescription: '4'
    backoff-base-ms:
        type: integer
        description: Backoff base delay ms
        defaultDescription: '200'
    backoff-cap-ms:
        type: integer
        description: Backoff cap ms
        defaultDescription: '10000'
    max-concurrent-requests:
        type: integer
        description: >
            Maximum number of simultaneous HTTP requests to the Genius API.
            Controls the connection_semaphore_ capacity.
            Tune together with songs-limit to avoid 429 bursts.
        defaultDescription: '3'
)");
}

// ════════════════════════════════════════════════════════════════════════════
// GeniusGet — resilient HTTP GET
//
// Порядок контроля перед отправкой запроса:
//
//   1. CircuitBreaker::AllowRequest()   — не бьём сломанный эндпоинт
//   2. CooldownGate::WaitForCooldown()  — ждём окончания 429-паузы
//   3. SemaphoreLock                    — не более N одновременных запросов
//   4. RateLimiter::AcquireSlot()       — захватываем слот квоты
//
// При получении 429:
//   a) Возвращаем слот (ReleaseSlot), т.к. квота нулевая
//   b) Активируем CooldownGate — все следующие корутины встанут на паузу
//   c) Текущая корутина спит через InterruptibleSleepFor
//   d) После пробуждения CooldownGate::WaitForCooldown() делает NotifyAll
//   e) Поток корутин возобновляется через семафор (по одной на слот)
// ════════════════════════════════════════════════════════════════════════════

std::string GeniusClient::GeniusGet(const std::string& url) const {
    const std::string auth = "Bearer " + genius_token_;

    // [1] CircuitBreaker: отказываем сразу, если известно что эндпоинт сломан.
    if (!circuit_breaker_.AllowRequest())
        throw GeniusHttpError{503, "circuit breaker open"};

    // [3] Thundering herd protection: если активен кулдаун от 429 —
    // паркуем корутину до его окончания, не трогая сеть.
    cooldown_gate_.WaitForCooldown();

    // [2] Concurrency limiter: захватываем семафорный слот.
    // SemaphoreLock — RAII, освобождает семафор при выходе из scope.
    // engine::Semaphore::SemaphoreLock паркует корутину (не поток!) если
    // свободных слотов нет.
    engine::SemaphoreLock sem_lock{connection_semaphore_};

    int attempt = 0;
    while (true) {
        // [4] Rate limiter: захватываем квотный слот.
        // Если слотов нет — корутина встаёт в очередь ConditionVariable.
        rate_limiter_.AcquireSlot();

        try {
            const auto resp = http_client_.CreateRequest()
                                  .get(url)
                                  .headers({{"Authorization", auth}})
                                  .timeout(std::chrono::seconds{5})
                                  .retry(0)
                                  .perform();
            const int status = resp->status_code();

            // Обновляем счётчик слотов из заголовков ответа.
            // Update() разбудит ждущие корутины, если remaining вырос.
            rate_limiter_.Update(ParseIntHeader(*resp,   "X-RateLimit-Remaining"),
                                 ParseInt64Header(*resp, "X-RateLimit-Reset"));

            // ── HTTP 429: Too Many Requests ──────────────────────────────
            if (status == 429) {
                // Возвращаем слот — квота нулевая, держать его бессмысленно.
                rate_limiter_.ReleaseSlot();

                using SC = std::chrono::system_clock;
                using Steady = std::chrono::steady_clock;

                const auto now_unix = static_cast<std::int64_t>(
                    std::chrono::duration_cast<std::chrono::seconds>(
                        SC::now().time_since_epoch()).count());
                const std::int64_t reset = ParseInt64Header(*resp, "X-RateLimit-Reset");
                const std::int64_t wait_secs =
                    (reset > now_unix) ? (reset - now_unix + 1) : 60;

                // Вычисляем дедлайн кулдауна в терминах steady_clock
                // (ConditionVariable работает с steady_clock::time_point).
                const auto cooldown_deadline =
                    Steady::now() + std::chrono::seconds{wait_secs};

                LOG_WARNING() << "[RL] 429 on " << url
                              << " — activating cooldown for " << wait_secs << "s";

                // Активируем ворота: все следующие корутины встанут на паузу.
                // Если ворота уже активны с более поздним дедлайном — no-op.
                cooldown_gate_.Activate(cooldown_deadline);

                // Текущая корутина спит через userver-native sleep.
                // Другие корутины в это время выполняются (non-blocking).
                engine::InterruptibleSleepFor(std::chrono::seconds{wait_secs});

                // После пробуждения ворота уже должны быть сброшены
                // (либо по дедлайну в WaitForCooldown, либо мы сбросим сами).
                // Но мы не вызываем WaitForCooldown повторно — просто continue.
                // Следующая итерация снова войдёт в AcquireSlot().
                continue;
            }

            // ── Success 2xx ───────────────────────────────────────────────
            if (status >= 200 && status < 300) {
                circuit_breaker_.RecordSuccess();
                return resp->body();
            }

            // ── Client errors 4xx (кроме 429) ────────────────────────────
            if (status >= 400 && status < 500) {
                circuit_breaker_.RecordFailure();
                throw GeniusHttpError{status, "HTTP " + std::to_string(status)};
            }

            // ── Server errors 5xx или неожиданный код ────────────────────
            LOG_WARNING() << "[Backoff] HTTP " << status
                          << " attempt=" << attempt << " url=" << url;

        } catch (const GeniusHttpError&) {
            throw;  // 4xx — пробрасываем без retry
        } catch (const std::exception& ex) {
            LOG_WARNING() << "[Backoff] network error attempt=" << attempt
                          << ": " << ex.what();
        }

        ++attempt;
        if (attempt >= backoff_max_attempts_) {
            circuit_breaker_.RecordFailure();
            throw GeniusHttpError{502, "exhausted retries: " + url};
        }

        // Перед повтором возвращаем слот — следующая итерация захватит заново.
        rate_limiter_.ReleaseSlot();
        engine::InterruptibleSleepFor(
            ExponentialBackoff(attempt, backoff_base_ms_, backoff_cap_ms_));
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

std::vector<Candidate>
GeniusClient::ResolveCandidates(const std::string& query) const {
    const std::string body =
        GeniusGet(genius_base_url_ + "/search?q=" + UrlEncode(query));
    const auto json   = formats::json::FromString(body);
    const auto& hits  = json["response"]["hits"];

    std::vector<Candidate> out;
    std::unordered_set<std::int64_t> seen;
    const std::string q = NormalizeName(query);

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
            c.score = Similarity(q, NormalizeName(c.name));
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

std::optional<ArtistRef> GeniusClient::FetchArtistById(std::int64_t id) const {
    try {
        const std::string body =
            GeniusGet(genius_base_url_ + "/artists/" + std::to_string(id));
        const auto& a = formats::json::FromString(body)["response"]["artist"];
        if (!a.IsObject()) return std::nullopt;
        return ArtistRef{
            a["id"].As<std::int64_t>(id), a["name"].As<std::string>(""),
            a["image_url"].As<std::string>(""), a["url"].As<std::string>("")};
    } catch (const std::exception& ex) {
        LOG_WARNING() << "FetchArtistById(" << id << "): " << ex.what();
        return std::nullopt;
    }
}

bool GeniusClient::HasCached(std::int64_t id) const {
    return artist_cache_.GetStale(id).has_value();
}

ArtistSongs GeniusClient::GetOrFetchArtistSongs(const ArtistRef& seed) const {
    if (auto v = artist_cache_.Get(seed.id)) return std::move(*v);
    try {
        ArtistSongs data = FetchArtistSongs(seed);
        artist_cache_.Put(seed.id, data);
        return data;
    } catch (const GeniusHttpError& e) {
        if (e.status_code == 503) {
            if (auto stale = artist_cache_.GetStale(seed.id)) {
                LOG_WARNING() << "[CB] stale cache for '" << seed.name << "'";
                return std::move(*stale);
            }
        }
        throw;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// FetchArtistSongs
//
// Изменение: каждая «song-detail» задача больше не запускается в изоляции.
// Все они вызывают GeniusGet(), который:
//   - ждёт окончания кулдауна (CooldownGate)
//   - захватывает семафорный слот (max-concurrent-requests)
//   - захватывает rate-limit слот (X-RateLimit-Remaining)
//
// Таким образом, даже если сюда пришёл запрос с 50 song_ids,
// реально в полёте одновременно будет не более max-concurrent-requests задач,
// а остальные плавно ждут своей очереди в планировщике userver.
// ════════════════════════════════════════════════════════════════════════════

ArtistSongs GeniusClient::FetchArtistSongs(const ArtistRef& seed) const {
    const std::string list_url =
        genius_base_url_ + "/artists/" + std::to_string(seed.id) +
        "/songs?sort=popularity&per_page=" + std::to_string(songs_limit_);

    const auto songs_json = formats::json::FromString(GeniusGet(list_url));
    const auto songs_arr  = songs_json["response"]["songs"];

    std::vector<std::int64_t> song_ids;
    if (songs_arr.IsArray()) {
        song_ids.reserve(songs_arr.GetSize());
        for (const auto& s : songs_arr) {
            const auto sid = s["id"].As<std::int64_t>(0);
            if (sid) song_ids.push_back(sid);
        }
    }

    // Запускаем все задачи сразу: GeniusGet() внутри каждой сам регулирует
    // конкурентность через семафор + rate limiter + cooldown gate.
    // Нет нужды в ручном батчинге — всё управляется примитивами синхронизации.
    struct Pending {
        std::int64_t                              id;
        engine::TaskWithResult<std::optional<SongRecord>> task;
    };
    std::vector<Pending> pending;
    pending.reserve(song_ids.size());

    for (const auto sid : song_ids) {
        std::string url = genius_base_url_ + "/songs/" + std::to_string(sid);
        pending.push_back(
            {sid,
             utils::Async(
                 "song-detail",
                 [this, url = std::move(url)]() -> std::optional<SongRecord> {
                     try {
                         const auto json =
                             formats::json::FromString(GeniusGet(url));
                         const auto& song = json["response"]["song"];
                         if (!song.IsObject()) return std::nullopt;

                         SongRecord rec;
                         rec.title = song["title"].As<std::string>("");
                         if (rec.title.empty())
                             rec.title = song["full_title"].As<std::string>("");

                         const auto push =
                             [&](const formats::json::Value& arr,
                                 const char* role) {
                                 for (const auto& a : ParseArtistArray(arr))
                                     if (a.id)
                                         rec.credits.push_back({a, role});
                             };

                         if (song.HasMember("primary_artist")) {
                             auto pa = ParseArtistObject(song["primary_artist"]);
                             if (pa.id)
                                 rec.credits.push_back({std::move(pa), "primary"});
                         }
                         push(song["producer_artists"], "producer");
                         push(song["writer_artists"],   "writer");
                         push(song["featured_artists"], "featured");
                         return rec;
                     } catch (const std::exception& ex) {
                         LOG_WARNING()
                             << "song-detail " << url << ": " << ex.what();
                         return std::nullopt;
                     }
                 })});
    }

    std::vector<SongRecord> records;
    records.reserve(pending.size());
    for (auto& p : pending) {
        try {
            auto r = p.task.Get();
            if (r) records.push_back(std::move(*r));
        } catch (const std::exception& ex) {
            LOG_WARNING() << "song-detail task sid=" << p.id
                          << ": " << ex.what();
        }
    }
    return {seed, std::move(records)};
}

} // namespace six_feat