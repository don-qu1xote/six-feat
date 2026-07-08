# Руководство для разработчиков

Полная техническая документация архитектуры, переменных окружения, тестирования и troubleshooting.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│ HTTP Handlers (graph, path, auth, status, healthz)              │
│ Task Processor: main-task-processor (8 worker threads)          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│ CollabService                                                    │
│ • BFS поиск кратчайшего пути между артистами                    │
│ • Path expansion limit: 3 раунда, frontier: 6 артистов/раунд   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│ ArtistRepository                                                │
│ • L2 cache: LRU на 512 артистов (TTL: 1800 сек)                │
│ • L1 cache: persistent PostgreSQL (userver Postgres-компонент)  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│ GeniusGateway + Rate Limiter (2 lanes)                          │
│ • Foreground lane: 8 тоек/сек, макс 3 параллельных запроса     │
│ • Background lane: 2 токена/сек, макс 1 параллельный запрос    │
│ • Circuit breaker: 30 сек на восстановление                    │
│ • Exponential backoff: от 200 мс до 10 сек                     │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
              ┌─────────────────────┐
              │  Genius API         │
              │ (OAuth per-user)    │
              └─────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ EnrichmentWorker (фоновый путь)                                 │
│ Task Processor: bg-enrichment (2 worker threads)                │
│ • Асинхронный глубокий скан коллаборативной сети                │
│ • Заполняет L2/L1 кэши для faster FG запросов                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Сервисы (IDEA-25 / IDEA-45 / IDEA-53)

Проект — не один процесс, а четыре независимых userver-сервиса из одного
репозитория (`docker-compose.yml` поднимает их все, каждый — свой Dockerfile
`target`):

| Сервис | Порт | Отвечает за | Postgres |
|---|---|---|---|
| **six-feat** (`src/`, бинарник `six_feat`) | 8080 | `/api/v1/graph`, `/api/v1/graph/path`, `/api/v1/search`, `/api/v1/status(/stream)`, `/`, `/healthz`, `/readyz` — и **локальную** проверку сессионной cookie на каждый запрос | да (L1 read-through) |
| **six-feat-enrichment** (`services/enrichment/`) | 8081 | Фоновый глубокий скан коллабораций (IDEA-25/26) | да (тот же кластер) |
| **six-feat-genius-gateway** (`services/genius-gateway/`) | 8082 | Весь исходящий трафик к Genius API — CircuitBreaker + FG/BG rate-limiting централизованы здесь (IDEA-45/46) | нет |
| **six-feat-auth** (`services/auth/`) | 8083 | Весь OAuth 2.0 Authorization Code Flow: `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me` (IDEA-53) | нет |

### OAuth: выдача сессии (six-feat-auth) vs проверка сессии (six-feat)

[IDEA-53] До этой итерации OAuth-хэндлеры (`LoginHandler`/`CallbackHandler`/
`LogoutHandler`/`MeHandler`, `src/auth/oauth_handler.cpp`) жили внутри
`six_feat`. Теперь они вынесены в отдельный сервис **six-feat-auth**, но
важно понимать, что вынесено, а что — нет:

- **Вынесено в six-feat-auth**: сам OAuth-флоу — редирект на Genius,
  обмен `code` на `access_token` (прямой HTTP к Genius `/oauth/token`, без
  прохождения через six-feat-genius-gateway — это одноразовый вызов на
  логин, а не FG/BG-трафик, которым занят gateway), шифрование сессии
  (`src/auth/session_crypto.cpp`) и установка/сброс cookie
  `six_feat_session`. Флаг `pkce-enabled` и вся PKCE-логика (RFC 7636)
  переехали вместе с флоу.
- **Осталось в six-feat**: проверка сессии на **каждый** запрос
  (`auth::RequireSession`/`auth::ExtractToken`, `src/auth/token_router.hpp`).
  Это принципиально: `RequireSession` расшифровывает cookie **локально**,
  тем же `APP_SECRET` (`session_crypto::KeyFromEnv()`), которым
  six-feat-auth её зашифровала — six-feat **не делает HTTP-вызов** к
  six-feat-auth на проверку сессии. Если бы каждый запрос к
  `/api/v1/graph`/`path`/`search`/`status`/`sse` шёл за подтверждением
  сессии в другой сервис по сети, это добавило бы латентность каждому
  хэндлеру данных — вместо этого расшифровка cookie остаётся
  O(1)-операцией в процессе.

Отсюда следствие: **оба** сервиса должны быть запущены с одинаковым
`APP_SECRET` (иначе six-feat не расшифрует cookie, выданную six-feat-auth)
и одинаковыми `GENIUS_CLIENT_ID`/`GENIUS_CLIENT_SECRET` (six-feat их больше
не использует для реального OAuth-обмена, но `OAuthConfig` всё ещё
валидирует их при старте — см. `static_config.yaml`).

### Маршрутизация `/auth/*`

В `docker-compose.yml` из этого репозитория **нет** общего входа/обратного
прокси перед `six-feat`/`six-feat-auth` — оба слушают собственные хостовые
порты (`8080` и `8083`). Поэтому:

- `GENIUS_REDIRECT_URI` должен указывать на **six-feat-auth**, а не на
  six-feat (по умолчанию `http://localhost:8083/auth/callback` — см.
  `services/auth/docker-entrypoint.sh`), и именно это значение нужно
  зарегистрировать как Redirect URI на https://genius.com/api-clients.
- Если вы ставите reverse proxy (nginx/traefik/…) перед обоими сервисами в
  продакшене — направляйте `/auth/*` на six-feat-auth, всё остальное на
  six-feat, и укажите `GENIUS_REDIRECT_URI` на публичный origin прокси.

---

## Переменные окружения

| Переменная | Тип | Обязательная | По умолчанию | Описание |
|---|---|---|---|---|
| `GENIUS_CLIENT_ID` | string | ✓ | — | OAuth 2.0 Client ID из https://genius.com/api-clients |
| `GENIUS_CLIENT_SECRET` | string | ✓ | — | OAuth 2.0 Client Secret — **никогда не коммитить в репозиторий** |
| `APP_SECRET` | string (64 hex) | ✓ | — | AES-256 ключ шифрования сессий; генерируется: `openssl rand -hex 32` |
| `GENIUS_REDIRECT_URI` | URL | ✗ | `http://localhost:8083/auth/callback` | Callback URI (six-feat-auth, IDEA-53), **должен точно совпадать** с зарегистрированным на genius.com |
| `COOKIE_SECURE` | bool | ✗ | `false` | Включить Secure флаг на cookies; установить `true` для HTTPS (production) |
| `DB_NAME` | string | ✓ | — | Имя базы PostgreSQL |
| `DB_USER` | string | ✓ | — | Пользователь PostgreSQL |
| `DB_PASSWORD` | string | ✓ | — | Пароль PostgreSQL — **никогда не коммитить в репозиторий** |
| `DB_HOST` | string | ✗ | `postgres` | Хост PostgreSQL master (имя сервиса в docker-compose) |
| `DB_PORT` | int | ✗ | `5432` | Порт PostgreSQL master |
| `DB_REPLICA_HOST` | string | ✗ | `postgres-replica` | Хост read-реплики (см. "Postgres cluster topology" ниже) |
| `DB_REPLICA_PORT` | int | ✗ | `5432` | Порт read-реплики |
| `DB_REPLICATION_USER` | string | ✓ (только для docker-compose) | — | Роль для стриминга WAL master → replica; используется `postgresql/primary-entrypoint.sh` и `postgresql/replica-entrypoint.sh`, приложением не читается |
| `DB_REPLICATION_PASSWORD` | string | ✓ (только для docker-compose) | — | Пароль роли репликации — **никогда не коммитить в репозиторий** |

**Примечание**: `GENIUS_CLIENT_ID` может храниться в конфиге (не секрет), но `GENIUS_CLIENT_SECRET` и `APP_SECRET` **всегда** передавать только через env vars.

---

## Postgres cluster topology

`PersistentStore` (`src/storage/persistent_store.cpp`) explicitly routes every read through `storages::postgres::ClusterHostType::kSlave` and every write through `kMaster` — this is intentional isolation, not decoration. `userver::storages::postgres::Cluster` discovers which DSN host is which **dynamically**, by running `SELECT pg_is_in_recovery()` against each host in `dbconnection` (topology refreshed every ~1s): a host that answers `false` is Master, everything else is Slave.

That means `dbconnection` (`db_connection_string` → `static_config.yaml`'s `postgres-db-1.dbconnection`) has to actually be a **multi-host DSN** — `postgresql://user:pass@host1:port1,host2:port2/db` — for a Slave pool to exist at all. If it only lists one host, `kSlave` requests find no Slave pool, log a `WARNING ... FindPool ... There is no pool for slave, falling back to master`, and every read silently lands on master too — the isolation the code assumes is in place quietly stops existing.

Docker-compose provides this out of the box:

- **`postgres`** — primary. Runs with `wal_level=replica`/`max_wal_senders`/`hot_standby=on`. `postgresql/primary-entrypoint.sh` idempotently creates a dedicated `REPLICATION`-only role and opens `pg_hba.conf` for it in the background on **every** boot — not just on a fresh `initdb` — so it also fixes up a pre-existing local dev volume that predates this feature, instead of only working on a brand-new `.pgdata`.
- **`postgres-replica`** — streaming standby of `postgres`. `postgresql/replica-entrypoint.sh` runs `pg_basebackup -R` against the primary on first boot (writing `standby.signal` + `primary_conninfo`), then just hands off to the upstream postgres entrypoint, which starts the data directory in recovery/hot-standby mode. On restarts PGDATA is already populated, so it skips straight to resuming standby recovery.
- `docker-entrypoint.sh` (the app's) assembles `DB_CONNECTION_STRING` from **both** `DB_HOST:DB_PORT` and `DB_REPLICA_HOST:DB_REPLICA_PORT` — see the env var table above.

Running against a single bare-metal/local Postgres outside docker-compose, with no second instance to point `DB_REPLICA_HOST` at: expect the `FindPool ... falling back to master` warning from the original issue this section describes — reads still work, just without the isolation from writes.

---

## Локальная разработка (без Docker)

### Требования

- **OS**: Ubuntu 22.04 (или совместимая)
- **C++ toolchain**: CMake 3.22+, GCC 11+ (или Clang 14+)
- **System libs**: `libpq-dev`, `libssl-dev`
- **PostgreSQL**: 14+ (локально или в Docker) — см. переменные `DB_*` выше
- **Python**: 3.10+ (для тестов)
- **Node.js**: 20+ (для фронта)

### Установка зависимостей

#### Ubuntu/Debian:
```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential cmake \
  libpq-dev libssl-dev \
  python3-dev python3-venv python3-pip \
  curl
```

#### macOS (Homebrew):
```bash
brew install cmake libpq openssl@3
```

### Сборка C++ backend

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
cmake --install build --prefix /tmp/six_feat_install
```

Бинарник: `/tmp/six_feat_install/bin/six_feat`

---

## Troubleshooting

### Сервис не стартует: не заданы `APP_SECRET` / `GENIUS_CLIENT_SECRET`

`docker-entrypoint.sh` проверяет обязательные переменные при старте и завершает процесс с явным сообщением, если они пустые:

```
GENIUS_CLIENT_ID env var is required for OAuth — from https://genius.com/api-clients
GENIUS_CLIENT_SECRET env var is required for OAuth — keep it secret
APP_SECRET env var is required for session encryption — generate with: openssl rand -hex 32
```

- `GENIUS_CLIENT_ID` / `GENIUS_CLIENT_SECRET` — регистрируются один раз на https://genius.com/api-clients.
- `APP_SECRET` — 64-символьный hex-ключ шифрования сессий: `openssl rand -hex 32`.

При запуске бинарника напрямую (без Docker) те же условия проверяет `OAuthConfig` (`src/auth/oauth_handler.cpp`): пустой/placeholder `client-id`, либо `redirect-uri`, не являющийся абсолютным `http(s)://` URL, приводят к `std::runtime_error` ещё до открытия порта.

### Login: Genius отвечает "Invalid Authorization"

Типовая причина — `redirect_uri`, который сервис отправляет на `/oauth/authorize`, не совпадает байт-в-байт с URI, зарегистрированным на https://genius.com/api-clients (схема, хост, порт, завершающий слэш — всё должно совпадать точно).

При старте сервис логирует фактически используемое значение:

```
[OAuth] redirect_uri configured as: <значение>
```

Сверьте эту строку из лога (переменная `GENIUS_REDIRECT_URI`, по умолчанию `http://localhost:8083/auth/callback` — six-feat-auth, IDEA-53) с настройками клиента на genius.com/api-clients и исправьте расхождение.

### 401 `token_invalid` после успешного входа

Сессионная cookie расшифровалась корректно, но access-токен Genius на момент запроса недействителен — истёк срок жизни либо пользователь отозвал доступ приложению на genius.com. Хэндлеры `graph`, `path`, `search` в этом случае возвращают `{"error": "token_invalid"}`; фронтенд (`front/src/api.js`) реагирует на этот код редиректом на `/auth/login`. Решение — перелогиниться.

### 429 / rate limit

- Для анонимных запросов действует пер-IP лимит с фиксированным окном (`PerIpRateLimit`, `src/core/rate_limiter.hpp`); авторизованные пользователи его не задевают — они ограничены только собственной OAuth-квотой Genius.
- При превышении хэндлеры `graph`/`path`/`search` отвечают `429 {"error": "rate_limit_exceeded"}` с заголовком `Retry-After: 1`.
- Если 429 приходит от самого Genius API, `GeniusGateway` включает кулдаун по `Retry-After` из ответа Genius (лог `[Pipeline] 429 — activating cooldown for ...`, `src/core/resilience.cpp`) — на это время запросы к Genius приостанавливаются автоматически.

### БД недоступна / `/readyz` не проходит

- Строка подключения к PostgreSQL собирается `docker-entrypoint.sh` из `DB_HOST`/`DB_PORT`/`DB_REPLICA_HOST`/`DB_REPLICA_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` в multi-host DSN (`host1,host2`) и передаётся в `static_config.yaml` через `postgres-db-1.dbconnection` (`$db_connection_string`) — никогда не коммитится. Убедитесь, что оба сервиса, `postgres` и `postgres-replica`, из `docker-compose.yml` здоровы (`depends_on: condition: service_healthy`) прежде чем разбираться с `/readyz`.
- Если в логах видите `WARNING ... FindPool ... There is no pool for slave, falling back to master` — у кластера нет Slave-хоста (см. "Postgres cluster topology" выше): либо `postgres-replica` не поднялся/не прошёл healthcheck, либо `DB_REPLICA_HOST`/`DB_REPLICA_PORT` не попали в DSN.
- Готовность проверяется через `GET /readyz`: вызывает `PersistentStore::Ping()` и возвращает `503` с `{"status":"not_ready","checks":{"database":{"ok":false}}}`, если БД недоступна.

### Граф не рендерится в браузере

`front/index.html` подключает `vis-network` с CDN (`unpkg.com`) с зафиксированным SRI-хешем (`integrity="sha384-..."`). Если версия файла на CDN разойдётся с той, под которую посчитан хеш (`vis-network@9.1.9`), браузер молча заблокирует загрузку скрипта — в консоли будет ошибка вида `Failed to find a valid digest`, граф останется пустым. Исправление: убедиться, что версия в URL совпадает с версией, под которую считался хеш, пересчитать `integrity`, либо самостоятельно захостить `vis-network` под `/vendor/` и убрать `integrity`/`crossorigin` (см. комментарий рядом с этим тегом в `index.html`).