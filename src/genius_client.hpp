#pragma once

// ════════════════════════════════════════════════════════════════════════════
// genius_client.hpp  —  iteration 5
//
// Изменения по сравнению с iteration 4:
//
//  1. CONCURRENCY LIMITER
//     Новое поле `engine::Semaphore connection_semaphore_` ограничивает
//     количество одновременных HTTP-запросов к Genius API.
//     Конфигурируется через `max-concurrent-requests` (default: 3).
//     Каждый вызов GeniusGet() захватывает SemaphoreLock до выхода.
//
//  2. SLOT-ORIENTED RATE LIMITER
//     RateLimiter теперь держит атомарный счётчик слотов (atomic<int>).
//     AcquireSlot() атомарно декрементирует счётчик; если слотов нет —
//     корутина встаёт в очередь ожидания (ConditionVariable) вместо
//     того, чтобы пролетать проверку одновременно с другими.
//     Слоты возвращаются через ReleaseSlot() или полностью пополняются
//     при вызове Update() с новым значением X-RateLimit-Remaining.
//
//  3. THUNDERING HERD PROTECTION (429 Cooldown Gate)
//     Новый класс CooldownGate: когда одна корутина получает HTTP 429,
//     она активирует «ворота» (устанавливает дедлайн кулдауна).
//     Все последующие корутины, вошедшие в GeniusGet(), проверяют ворота
//     через WaitForCooldown() и блокируются на ConditionVariable до
//     истечения кулдауна — вместо того, чтобы самостоятельно штурмовать
//     API и независимо засыпать на 60 секунд каждая.
//     После истечения кулдауна все ждущие корутины просыпаются разом
//     (broadcast), и конкурентность снова регулируется семафором.
//
//  Все примитивы — userver-native (engine::Semaphore, engine::Mutex,
//  engine::ConditionVariable, engine::InterruptibleSleepFor), что
//  гарантирует неблокирующий ввод-вывод в модели корутин userver.
// ════════════════════════════════════════════════════════════════════════════

#include <atomic>
#include <chrono>
#include <cstdint>
#include <list>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include <userver/clients/http/client.hpp>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/condition_variable.hpp>
#include <userver/engine/mutex.hpp>
#include <userver/engine/semaphore.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/yaml_config/schema.hpp>

namespace six_feat {

// ════════════════════════════════════════════════════════════════════════════
// Domain types
// ════════════════════════════════════════════════════════════════════════════

struct ArtistRef {
    std::int64_t id{0};
    std::string  name;
    std::string  image;
    std::string  url;
};

struct TrackCredit {
    ArtistRef   artist;
    std::string role;   // "featured" | "producer" | "writer" | "primary"
};

struct SongRecord {
    std::string              title;
    std::vector<TrackCredit> credits;
};

struct ArtistSongs {
    ArtistRef               seed;
    std::vector<SongRecord> songs;
};

struct Candidate {
    std::int64_t id{0};
    std::string  name;
    std::string  image;
    std::string  url;
    double       score{0.0};
};

struct RoleMask {
    bool primary{true};
    bool producer{true};
    bool writer{true};
    bool featured{true};
};

// ════════════════════════════════════════════════════════════════════════════
// LruCache<K,V>
// ════════════════════════════════════════════════════════════════════════════

template <typename K, typename V>
class LruCache {
public:
    using Clock    = std::chrono::steady_clock;
    using Duration = std::chrono::seconds;

    explicit LruCache(std::size_t max_size, Duration ttl)
        : max_size_(max_size), ttl_(ttl) {}

    std::optional<V> Get(const K& key) {
        std::lock_guard lock(mu_);
        auto it = index_.find(key);
        if (it == index_.end()) return std::nullopt;
        if (IsExpired(it->second->expires_at)) return std::nullopt;
        list_.splice(list_.begin(), list_, it->second);
        return it->second->value;
    }

    std::optional<V> GetStale(const K& key) {
        std::lock_guard lock(mu_);
        auto it = index_.find(key);
        if (it == index_.end()) return std::nullopt;
        list_.splice(list_.begin(), list_, it->second);
        return it->second->value;
    }

    void Put(const K& key, V value) {
        std::lock_guard lock(mu_);
        auto it = index_.find(key);
        if (it != index_.end()) {
            it->second->value      = std::move(value);
            it->second->expires_at = Clock::now() + ttl_;
            list_.splice(list_.begin(), list_, it->second);
            return;
        }
        if (list_.size() >= max_size_) {
            index_.erase(list_.back().key);
            list_.pop_back();
        }
        list_.push_front(Entry{key, std::move(value), Clock::now() + ttl_});
        index_[key] = list_.begin();
    }

    std::size_t Size() const {
        std::lock_guard lock(mu_);
        return list_.size();
    }

private:
    struct Entry {
        K                              key;
        V                              value;
        std::chrono::time_point<Clock> expires_at;
    };
    static bool IsExpired(const std::chrono::time_point<Clock>& tp) {
        return Clock::now() >= tp;
    }
    mutable std::mutex mu_;
    std::size_t        max_size_;
    Duration           ttl_;
    std::list<Entry>   list_;
    std::unordered_map<K, typename std::list<Entry>::iterator> index_;
};

// ════════════════════════════════════════════════════════════════════════════
// CooldownGate — защита от thundering herd при HTTP 429
//
// Принцип работы:
//   Когда корутина получает 429, она вызывает Activate(deadline):
//     - Устанавливает дедлайн кулдауна.
//     - Все последующие корутины, вызывающие WaitForCooldown(), блокируются
//       на ConditionVariable до истечения дедлайна.
//     - По истечении — NotifyAll(), все корутины продолжают работу.
//
// Почему engine::Mutex + engine::ConditionVariable, а не std::mutex:
//   std::mutex блокирует OS-поток, убивая модель корутин userver.
//   engine::Mutex переключает планировщик — корутина паркуется без
//   блокировки потока, другие корутины продолжают выполняться.
// ════════════════════════════════════════════════════════════════════════════

class CooldownGate {
public:
    using Clock    = std::chrono::steady_clock;
    using TimePoint = Clock::time_point;

    // Активировать кулдаун до `deadline`.
    // Если кулдаун уже активен с более поздним дедлайном — не трогаем его.
    void Activate(TimePoint deadline);

    // Заблокировать вызывающую корутину, пока активен кулдаун.
    // Использует engine::ConditionVariable — не блокирует OS-поток.
    void WaitForCooldown();

    // True, если кулдаун сейчас активен.
    bool IsActive() const;

private:
    mutable userver::engine::Mutex      mu_;
    userver::engine::ConditionVariable  cv_;
    TimePoint                           deadline_{};   // zero = неактивен
    bool                                active_{false};
};

// ════════════════════════════════════════════════════════════════════════════
// RateLimiter — slot-oriented token bucket
//
// Изменения по сравнению с предыдущей версией:
//
//   Старая версия просто читала `remaining_` и засыпала, если он ≤ kMinRemaining.
//   Проблема: все N корутин читают значение одновременно, видят remaining > min,
//   проходят проверку, разом отправляют запросы — и взрывают API.
//
//   Новая версия:
//     - `available_slots_` — атомарный счётчик доступных слотов.
//     - AcquireSlot() атомарно декрементирует CAS-петлёй. Если слотов нет
//       (≤ kMinRemaining), корутина блокируется на ConditionVariable.
//     - ReleaseSlot() — явный возврат слота (вызывается из GeniusGet при
//       429/ошибке, чтобы не удерживать слот зря).
//     - Update() пополняет счётчик до нового значения из заголовка
//       X-RateLimit-Remaining и будит ждущие корутины.
// ════════════════════════════════════════════════════════════════════════════

class RateLimiter {
public:
    static constexpr int kMinRemaining = 2;

    // Обновить счётчик из заголовков ответа.
    // Будит корутины, ждущие слота, если remaining вырос.
    void Update(int remaining, std::int64_t reset_unix);

    // Атомарно захватить один слот.
    // Если слотов нет — блокируется до появления слота или до reset.
    // Возвращает true, если слот захвачен; false — если пора cooldown.
    void AcquireSlot();

    // Вернуть слот (при ошибке/429 до обновления заголовков).
    void ReleaseSlot();

    int  Remaining() const;

private:
    // Ждёт пока available_slots_ > kMinRemaining, затем декрементирует CAS.
    void WaitAndDecrement();

    mutable userver::engine::Mutex     mu_;
    userver::engine::ConditionVariable cv_;

    int          remaining_{-1};      // последнее известное значение из заголовка
    std::int64_t reset_unix_{0};      // UNIX-timestamp сброса счётчика
    int          available_slots_{-1}; // -1 = не инициализировано (нет данных от API)
};

// ════════════════════════════════════════════════════════════════════════════
// CircuitBreaker (без изменений)
// ════════════════════════════════════════════════════════════════════════════

class CircuitBreaker {
public:
    enum class State : int { Closed = 0, Open = 1, HalfOpen = 2 };

    explicit CircuitBreaker(int failure_threshold,
                            std::chrono::seconds open_duration)
        : failure_threshold_(failure_threshold),
          open_duration_(open_duration) {}

    bool  AllowRequest();
    void  RecordSuccess();
    void  RecordFailure();
    State CurrentState() const;

private:
    void Trip();
    void Reset();

    const int                  failure_threshold_;
    const std::chrono::seconds open_duration_;
    mutable std::mutex         mu_;
    std::atomic<State>         state_{State::Closed};
    int                        consecutive_failures_{0};
    std::chrono::steady_clock::time_point trip_time_{};
};

// ════════════════════════════════════════════════════════════════════════════
// GeniusHttpError
// ════════════════════════════════════════════════════════════════════════════

struct GeniusHttpError : std::runtime_error {
    int status_code;
    explicit GeniusHttpError(int code, const std::string& msg)
        : std::runtime_error(msg), status_code(code) {}
};

// ════════════════════════════════════════════════════════════════════════════
// GeniusClient — shared userver component
// ════════════════════════════════════════════════════════════════════════════

class GeniusClient final : public userver::components::ComponentBase {
public:
    static constexpr std::string_view kName = "genius-client";

    GeniusClient(const userver::components::ComponentConfig&  config,
                 const userver::components::ComponentContext& context);

    static userver::yaml_config::Schema GetStaticConfigSchema();

    // ── Public API ───────────────────────────────────────────────────────

    std::vector<Candidate> ResolveCandidates(const std::string& query) const;
    std::optional<ArtistRef> FetchArtistById(std::int64_t id) const;
    ArtistSongs GetOrFetchArtistSongs(const ArtistRef& seed) const;
    bool HasCached(std::int64_t id) const;

    double      MatchThreshold()  const { return match_threshold_; }
    int         SongsLimit()      const { return songs_limit_; }
    std::string GeniusBaseUrl()   const { return genius_base_url_; }

private:
    std::string  GeniusGet(const std::string& url) const;
    ArtistSongs  FetchArtistSongs(const ArtistRef& seed) const;

    userver::clients::http::Client& http_client_;
    const std::string               genius_token_;
    const std::string               genius_base_url_;
    const int                       songs_limit_;
    const double                    match_threshold_;

    mutable RateLimiter    rate_limiter_;
    mutable CircuitBreaker circuit_breaker_;
    mutable CooldownGate   cooldown_gate_;     // ← thundering herd guard (new)

    const int                       backoff_max_attempts_;
    const std::chrono::milliseconds backoff_base_ms_;
    const std::chrono::milliseconds backoff_cap_ms_;

    // ── Concurrency limiter (new) ─────────────────────────────────────────
    // engine::Semaphore — coroutine-friendly, не блокирует OS-поток.
    // Инициализируется из конфига `max-concurrent-requests`.
    mutable userver::engine::Semaphore connection_semaphore_;

    mutable LruCache<std::int64_t, ArtistSongs> artist_cache_;
};

} // namespace six_feat