# Руководство для разработчиков

Полная техническая документация архитектуры, переменных окружения, тестирования и troubleshooting.

История задач (что сделано, в каком спринте, каким тестом покрыто, и
маппинг легаси `IDEA-N` на текущую нумерацию `SF-AREA-NN`) — в
[ROADMAP.md](./ROADMAP.md), не здесь.

Обоснование ключевых архитектурных решений (почему сервисов пять,
почему сессия проверяется локально, почему схемы вынесены в YAML и
т.д.) — в [docs/adr/](./docs/adr/README.md), не здесь.

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

Почему именно такое разбиение — в [ADR-0001](./docs/adr/0001-split-into-four-services.md)
(и по каждому сервису отдельно: [ADR-0002](./docs/adr/0002-enrichment-standalone-service.md)
для enrichment, [ADR-0003](./docs/adr/0003-genius-gateway-centralizes-rate-limiting.md)
для genius-gateway, [ADR-0004](./docs/adr/0004-auth-service-local-session-verification.md)
для auth, [ADR-0007](./docs/adr/0007-game-mode-as-separate-service.md) для game).
Здесь — только таблица портов/ответственности.

Проект — не один процесс, а пять независимых userver-сервисов из одного
репозитория (`docker-compose.yml` поднимает их все, каждый — свой Dockerfile
`target`):

| Сервис | Порт | Отвечает за | Postgres |
|---|---|---|---|
| **six-feat** (`services/six-feat/`, бинарник `six_feat`) | 8080 | `/api/v1/graph`, `/api/v1/graph/path`, `/api/v1/search`, `/api/v1/status(/stream)`, `/`, `/healthz`, `/readyz` — и **локальную** проверку сессионной cookie на каждый запрос | да (L1 read-through) |
| **six-feat-enrichment** (`services/six-feat-enrichment/`) | 8081 | Фоновый глубокий скан коллабораций (IDEA-25/26) | да (тот же кластер) |
| **six-feat-genius-gateway** (`services/genius-gateway/`) | 8082 | Весь исходящий трафик к Genius API — CircuitBreaker + FG/BG rate-limiting централизованы здесь (IDEA-45/46) | нет |
| **six-feat-auth** (`services/auth/`) | 8083 | Весь OAuth 2.0 Authorization Code Flow: `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me` (IDEA-53) | нет |
| **six-feat-game** (`services/game/`) | 8084 | Игровой режим «собери цепочку»: `/api/v1/game/{profile,challenge,challenges,validate,submit,leaderboard,season,link,admin}`. Сессия читается **локально** (как в six-feat), анти-чит ходит в six-feat через internal-mesh `/internal/neighbours` (ADR-0007) | да (тот же кластер, свой реестр миграций `postgresql/migrations/game/`) |

### Раскладка исходников сервиса

Каждый сервис организован по URL-пути (см. SF-STR-10): хендлеры
раскладываются в `api/v1/` для `/api/v1/*` роутов, `internal/` для
`/internal/*` и `system/` для `/healthz`/`/readyz`. Не-HTTP код —
в `core/`, `infrastructure/`, `application/` или `auth/`.

### OAuth: выдача сессии (six-feat-auth) vs проверка сессии (six-feat)

Обоснование того, почему проверка сессии осталась локальной, а не стала
HTTP-вызовом к six-feat-auth — [ADR-0004](./docs/adr/0004-auth-service-local-session-verification.md).

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
   (`auth::RequireSession`/`auth::ExtractToken`, `src/token_router.hpp`).
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
| `DB_REPLICA_HOST` | string | ✗ | *(пусто)* | Хост read-реплики; не задан — работаем против одного инстанса (см. "Postgres cluster topology" ниже) |
| `DB_REPLICA_PORT` | int | ✗ | `5432` | Порт read-реплики (используется только если задан `DB_REPLICA_HOST`) |
| `DB_REPLICATOR_USER` | string | ✗ | `replicator` | Роль для физической репликации (`prod-like` профиль, см. ниже) |
| `DB_REPLICATOR_PASSWORD` | string | ✗ | `replicator_dev_password` | Пароль роли репликации — сменить для чего угодно за пределами local dev |

**Примечание**: `GENIUS_CLIENT_ID` может храниться в конфиге (не секрет), но `GENIUS_CLIENT_SECRET` и `APP_SECRET` **всегда** передавать только через env vars.

---

## Env-профили: dev/staging/prod (SF-CFG-01)

До этого раздела различия между dev/staging/prod (уровень логов, `COOKIE_SECURE`, `DB_REPLICA_HOST`) были просто разрозненными `${VAR:-default}`-хардкодами в каждом `docker-entrypoint.sh`. `config/profiles/{dev,staging,prod}.env` формализуют именно эти дефолты — сами файлы ничего нового не добавляют, только называют то, что уже было неявным.

**Единственная команда запуска для всех трёх окружений** — `docker-compose.yml` один и тот же, различие только в `ENV_PROFILE`:

```bash
ENV_PROFILE=dev     docker compose up -d   # по умолчанию, если ENV_PROFILE не задан
ENV_PROFILE=staging docker compose up -d
ENV_PROFILE=prod    docker compose up -d
```

**Правило на будущее** (важно для SF-CFG-02, который проверяет это автоматически): никаких `docker-compose.staging.yml` / `docker-compose.prod.yml` с дублирующими service-блоками. Единственный источник правды — этот `docker-compose.yml`; любое различие между окружениями идёт **только** через переменные (`ENV_PROFILE` + `.env`), никогда через второй YAML.

Как это работает:

1. `ENV_PROFILE` (по умолчанию `dev`) — обычная переменная окружения, пробрасывается в каждый из 5 app-контейнеров через `docker-compose.yml`'s `environment:` (как и любая другая), плюс read-only bind-mount `./config/profiles:/app/config/profiles:ro` — тот же приём, что уже используется для `nginx/default.conf.template`, `observability/prometheus/rules` и т.д.
2. Каждый `docker-entrypoint.sh` в самом начале (до секретов `${VAR:?...}`) проверяет `/app/config/profiles/${ENV_PROFILE}.env` — **fail-fast**, если файла нет (та же строгость, что уже используют `${VAR:?Set VAR}` для секретов):
   ```
   [entrypoint] ERROR: ENV_PROFILE=typo but /app/config/profiles/typo.env not found (expected dev, staging, or prod — see config/profiles/)
   ```
3. Найденный файл `source`-ится (`set -a; source ...; set +a`), а не просто читается — потому что сами профили написаны в том же идиоме `VAR="${VAR:-default}"`, что и дефолты в `docker-entrypoint.sh`. Это даёт конкретный порядок приоритета:

   **явное значение в `.env`/shell → профиль → встроенный дефолт `docker-entrypoint.sh`**

   Если вы вручную выставили `LOGGING_LEVEL=debug` в своём `.env` для отладки — эта переменная приходит в контейнер уже непустой (`docker-compose.yml` теперь пробрасывает `LOGGING_LEVEL: ${LOGGING_LEVEL:-}`, т.е. пусто, если не задано явно), и `${LOGGING_LEVEL:-info}` внутри профиля её не тронет. Профиль подставляет значение только там, где до него ничего не было задано.

Что входит в профиль сейчас (см. сами файлы в `config/profiles/` — там же и обоснование каждого значения):

| Переменная | dev | staging | prod |
|---|---|---|---|
| `LOGGING_LEVEL` | `info` | `info` | `warning` |
| `COOKIE_SECURE` | `false` | `true` | `true` |
| `DB_REPLICA_HOST` | *(пусто)* | *(пусто)* | `postgres-replica` |

`dev.env` намеренно совпадает с прежними дефолтами `docker-entrypoint.sh` один в один — `ENV_PROFILE` не меняет поведение по умолчанию, только называет его. `prod.env`'s `DB_REPLICA_HOST=postgres-replica` — рабочее значение для собственного `prod-like` compose-профиля этого репозитория (SF-INF-02, `docker compose --profile prod-like up`); для реального внешнего кластера переопределяйте `DB_REPLICA_HOST` напрямую в `.env`.

**Rate-limit пороги пока не входят в профиль**: на момент SF-CFG-01 они не env-конфигурируемы вообще (захардкожены как литералы прямо в конструкторах хендлеров, например `rate_limit_("graph", 50, 1, ...)` в `graph_handler.cpp`) — заводить под них переменные профиля значило бы придумывать конфигурацию, которой ничего не пользуется. Если/когда они станут env-конфигурируемыми — их место здесь, в этой же таблице.

**Тест**: `scripts/verify-env-profiles.py` — проверяет, что все три файла профиля реально парсятся (`bash source` в чистом окружении) и что ни один не пытается задать одну из required-переменных `docker-compose.yml` (`${VAR:?...}`: `GENIUS_CLIENT_ID`, `GENIUS_CLIENT_SECRET`, `APP_SECRET`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `ENRICHMENT_INTERNAL_SECRET`) — профили формализуют только опциональные ручки, никогда секреты:

```bash
python3 scripts/verify-env-profiles.py
```

### Паритет docker-compose между окружениями (SF-CFG-02)

Единственный источник правды — этот `docker-compose.yml`. **Правило**: никаких `docker-compose.staging.yml` / `docker-compose.prod.yml` с дублирующими service-блоками — разница между dev/staging/prod только в `ENV_PROFILE`, сам YAML не трогаем.

Одна и та же команда для всех трёх окружений:

```bash
ENV_PROFILE=dev     docker compose up -d
ENV_PROFILE=staging docker compose up -d
ENV_PROFILE=prod    docker compose up -d
```

`scripts/verify-env-parity.py` сверяет `docker compose config` (без реального `up`) для всех трёх профилей: набор сервисов, image/build, volumes, healthcheck и т.д. должны совпадать один в один. Расхождение допускается только в переменных из allow-list (`ENV_PROFILE`, `LOGGING_LEVEL`, `COOKIE_SECURE`, `DB_REPLICA_HOST` — та же таблица, что выше) — любое другое расхождение (лишняя переменная, другой image, другой сервис) — ошибка:

```bash
python3 scripts/verify-env-parity.py
```

Гоняется в CI на каждый PR (шаг `verify-env-parity`, до интеграционных тестов) — ловит расхождение сразу, а не когда staging уже разъехался с dev.

---

## Postgres cluster topology

`PersistentStore` (`src/storage/persistent_store.cpp`) routes every write through `storages::postgres::ClusterHostType::kMaster` — intentional isolation, not decoration. Reads route through `kSlave` **only when a replica is actually configured** (`DB_REPLICA_HOST` set — see `ReadHostType()` in that file), otherwise straight through `kMaster` too. `userver::storages::postgres::Cluster` discovers which DSN host is which **dynamically**, by running `SELECT pg_is_in_recovery()` against each host in `dbconnection` (topology refreshed every ~1s): a host that answers `false` is Master, everything else is Slave.

That means `dbconnection` (`db_connection_string` → `static_config.yaml`'s `postgres-db-1.dbconnection`) has to actually be a **multi-host DSN** — `postgresql://user:pass@host1:port1,host2:port2/db` — for a Slave pool to exist at all. If it only lists one host, a `kSlave` request would find no Slave pool and log `WARNING ... FindPool ... There is no pool for slave, falling back to master` — `ReadHostType()` sidesteps this entirely in the single-host case by never issuing a `kSlave` request to begin with, so that warning no longer fires on every read in the default profile (it's still possible, briefly, right after `DB_REPLICA_HOST` is first set and Cluster hasn't finished its first `pg_is_in_recovery()` topology probe yet — that's the one case where it's still a genuinely transient, not permanent, log line).

**docker-compose.yml runs a single Postgres instance by default** — `postgres-replica` exists in the file but is gated behind the `prod-like` profile, so a bare `docker compose up` never starts it. This is a deliberate trade-off for local dev on modest hardware: a real standby means a second always-on Postgres process plus continuous WAL streaming, for a benefit (read/write isolation) that only matters once you're actually testing replication-lag-sensitive behavior. `DB_REPLICA_HOST` defaults to empty, `docker-entrypoint.sh` builds a single-host DSN, and `PersistentStore` reads master directly — this is expected, not a bug, and doesn't spam the logs.

To get genuine Master/Slave isolation (e.g. against a staging cluster with a real streaming standby), set `DB_REPLICA_HOST`/`DB_REPLICA_PORT` to that standby's address — `docker-entrypoint.sh` then assembles the multi-host DSN, and `PersistentStore` (seeing `DB_REPLICA_HOST` set) starts routing reads through `kSlave` again. **Do not** point `DB_REPLICA_HOST` at the same host as `DB_HOST` to "fake" a replica: both DSN entries would resolve to the same live primary, both would answer `pg_is_in_recovery() = false`, and you'd land back in the exact `no pool for slave, falling back to master` case — just with a config that looks like it should be working, which is worse than not setting it at all.

### `prod-like` профиль — реальная standby-реплика (SF-INF-02)

`docker-compose.yml` умеет поднять настоящую streaming-репликацию локально, без внешнего staging-кластера — профиль `prod-like`:

```bash
docker compose --profile prod-like up -d
```

Это поднимает, в дополнение к обычному дефолтному набору сервисов, ещё и `postgres-replica` (`postgres:16-alpine`, тот же образ, что и у `postgres`). `postgres-replica` **не** отдельный «postgres-primary» — существующий, всегда включённый сервис `postgres` продолжает играть роль мастера и под этим профилем тоже: это осознанное решение, а не половинчатая реализация. Compose-профили работают так, что сервис без `profiles:` активен всегда, и если он через `depends_on` жёстко зависит от сервиса из профилированной группы, Compose автоматически поднимает и этот профиль — то есть будь `postgres` тоже спрятан за `prod-like` с жёстким `depends_on` от `six-feat`, дефолтный `docker compose up` начал бы неявно поднимать `prod-like` каждый раз. Вместо этого `postgres` остаётся неизменным между профилями (мастером), а `postgres-replica` — единственный новый, действительно профилированный сервис; связь `six-feat` → `postgres-replica` остаётся мягкой, через `DB_REPLICA_HOST`, как и раньше.

Как это работает изнутри:

- `postgres` дополнительно монтирует `postgresql/prod-like/init-replication.sh` в `/docker-entrypoint-initdb.d/` — при первом (и только первом) старте на пустом data dir создаёт роль `DB_REPLICATOR_USER` с `REPLICATION LOGIN` и открывает `pg_hba.conf` для физических replication-подключений. Эта роль безвредна и при дефолтном профиле — раз `postgres-replica` не стартует, ей просто никто не пользуется.
- `postgres` теперь также запускается с `wal_level=replica`, `max_wal_senders`, `max_replication_slots`, `hot_standby=on` — необходимые для streaming replication параметры, применяются всегда (снова: безвредно, если реплики нет).
- `postgres-replica` использует кастомный entrypoint (`postgresql/prod-like/replica-entrypoint.sh`): на пустом data dir дожидается готовности `postgres`, снимает физический бэкап через `pg_basebackup -R` (флаг `-R` сам пишет `standby.signal` + `primary_conninfo` в `postgresql.auto.conf` — актуальный, PG12+, механизм вместо старого `recovery.conf`), затем передаёт управление штатному `docker-entrypoint.sh postgres` образа. При рестарте (непустой data dir) бэкап не повторяется — `standby.signal` уже на месте, Postgres просто снова стартует как standby.

Чтобы `PersistentStore` реально начал разделять чтения/записи под этим профилем, задайте `DB_REPLICA_HOST=postgres-replica` (например, в `.env`):

```bash
DB_REPLICA_HOST=postgres-replica
```

**Проверка**:

1. `docker compose --profile prod-like up -d` — дождаться, пока `postgres-replica` пройдёт healthcheck (`pg_isready`).
2. `docker compose exec postgres-replica psql -U "$DB_USER" -d "$DB_NAME" -c 'SELECT pg_is_in_recovery();'` → `t` (реплика в режиме standby).
3. `docker compose exec postgres psql -U "$DB_USER" -d "$DB_NAME" -c 'SELECT pg_is_in_recovery();'` → `f` (мастер жив и остаётся мастером).
4. С `DB_REPLICA_HOST=postgres-replica` в окружении `six-feat` — обычные чтения графа (`GET /api/v1/graph?...`) продолжают отвечать `200`, но теперь идут через `kSlave`-пул на `postgres-replica` (`ReadHostType()` теперь возвращает `kSlave`, раз `DB_REPLICA_HOST` задан).

Существующий локальный `.pgdata` (созданный до появления этого профиля) не подхватит новую replication-роль автоматически — `/docker-entrypoint-initdb.d/*.sh` выполняется только на пустом data dir. Для `prod-like` на уже существующем окружении нужен свежий volume `postgres`.

---

## Backup & restore (SF-INF-08)

`scripts/backup-postgres.sh` снимает логический дамп (`pg_dump -Fc`, custom format), `scripts/restore-postgres.sh` разворачивает его обратно. Расписание — сервис `postgres-backup` в `docker-compose.yml` за профилем `backup`.

**Реплика — это не бэкап.** `postgres-replica` (SF-INF-02, профиль `prod-like`) защищает от нагрузки и от потери хоста с мастером. От потери *данных* она не защищает вообще: любой `DELETE`, любая неудачная миграция, любой `DROP TABLE` приезжают на standby за миллисекунды. Восстановиться из такого можно только из дампа. Это две разные задачи, и нужны обе.

**Два разных «профиля», не перепутайте.** `ENV_PROFILE=dev|staging|prod` (SF-CFG-01, раздел «Env-профили» выше) выбирает *значения* переменных и на состав сервисов не влияет. Compose-ключ `profiles:` решает, *запускается* ли сервис вообще. Бэкапы — второе: `postgres-backup` стоит за compose-профилем `backup` и не поднимается обычным `docker compose up`, независимо от `ENV_PROFILE`. Включать его надо там, где он нужен — на staging и prod:

```bash
ENV_PROFILE=prod docker compose --profile backup up -d
```

Разделение намеренное: `verify-env-parity.py` требует одинаковый *набор* сервисов во всех `ENV_PROFILE`, поэтому «сервис, которого нет в dev» не может быть выражен через `ENV_PROFILE` — только через `profiles:`.

```bash
# разово, вручную
DB_NAME=six_feat DB_USER=six_feat DB_PASSWORD=... BACKUP_DIR=./.backups \
  ./scripts/backup-postgres.sh

# по расписанию (не стартует при обычном docker compose up)
docker compose --profile backup up -d

# восстановление — молча ничего не перезапишет
./scripts/restore-postgres.sh ./.backups/six-feat-six_feat-20260728T030000Z.dump --dry-run
./scripts/restore-postgres.sh ./.backups/six-feat-six_feat-20260728T030000Z.dump --yes-i-am-sure
```

### RPO — сколько данных теряется

**RPO = интервал между бэкапами. Ровно он, без округления в свою пользу.**

| `BACKUP_SCHEDULE` | RPO (худший случай) |
| --- | --- |
| `0 3 * * *` (по умолчанию, раз в сутки) | **24 часа** |
| `0 */6 * * *` | 6 часов |
| `0 * * * *` | 1 час |

Худший случай — не средний: если база умирает в 02:59, а дамп снимается в 03:00, теряются почти полные сутки записей. Это не пессимистичная оценка, а определение.

**Чего здесь нет:** WAL-архивирования и point-in-time recovery. PITR даёт RPO в секунды, но требует непрерывной выгрузки WAL и отдельного хранилища — этот тикет их не реализует. Пока RPO нельзя опустить ниже интервала, кроме как учащая сам интервал; это упирается в длительность дампа (см. ниже), а не в скрипт.

### RTO — сколько занимает восстановление

RTO складывается из четырёх слагаемых, и **измеримое из них — не самое большое**:

| Этап | Время | Основание |
| --- | --- | --- |
| 1. Заметить и принять решение | **минуты–часы, не измерено** | доминирующее слагаемое; см. ниже |
| 2. Достать дамп | секунды (локальный диск) / размер ÷ канал (S3) | — |
| 3. `pg_restore` | **≈1 минута на 1 ГБ базы** | замер, см. ниже |
| 4. Проверить и переключить трафик | минуты, вручную | — |

Замер (`postgres:16`, локальный loopback, без конкурентной нагрузки):

| | значение |
| --- | --- |
| размер базы | 155 МБ (1.4 млн строк: 200k artists, 500k songs, 500k credits, 200k fetch_state) |
| `pg_dump -Fc --compress=9` | **2.9 с** → файл 8.4 МБ |
| `pg_restore` в пустую базу | **8.9 с** |

Отсюда порядок величины: дамп ≈20 с/ГБ, восстановление ≈60 с/ГБ. Восстановление примерно втрое дольше дампа — оно строит индексы и проверяет constraints заново.

**Оговорки, без которых эти числа врут:**

* синтетические данные с повторяющимися строками сжимаются радикально лучше настоящих — на реальной базе ждите файл заметно больше 8.4 МБ на те же 155 МБ, и дамп подольше;
* замер на loopback, без конкурентной нагрузки и без сети между клиентом и сервером; на проде оба этапа медленнее;
* `pg_restore` запускается однопоточно (без `-j`); на многоядерном хосте параллельный restore заметно быстрее, но скрипт этого сознательно не делает — `--exit-on-error` в паре с `-j` хуже диагностируется;
* экстраполяция линейна, а индексы растут не линейно; для базы на порядок больше проверьте замером, а не умножением.

**Этап 1 обычно и есть настоящий RTO.** Алерты (SF-OBS-04) реагируют на симптомы — сервис лёг, база недоступна, — а не на «данные удалены». Потеря данных чаще всего замечается человеком, и до этого момента таймер RTO уже идёт. Никакая скорость `pg_restore` этого не компенсирует.

**Бэкап, который ни разу не восстанавливали, — не бэкап.** `tests/test_backup_restore.py` проверяет round-trip на каждом прогоне CI, но на синтетической базе. Периодический прогон `restore-postgres.sh --target-db six_feat_verify --create` на копии продовых данных — единственный способ узнать реальный RTO и то, что дамп вообще разворачивается. Ставьте это в календарь: цифры выше устареют, как только база вырастет.

---

## Кэширование ответов (ETag) и `request_id` в ошибках

`/api/v1/graph`, `/api/v1/graph/path` и `/api/v1/search` (`SF-API-04`)
отвечают слабым `ETag` (RFC 7232 §2.3, `W/"..."`) и
`Cache-Control: private, must-revalidate` на каждый успешный ответ:

- **graph** — тег строится из `seed_id`, `fetch_state.depth`/`song_count`
  (та же величина, что опрашивает `/api/v1/status`), маски ролей,
  `truncated`/`song_limit` — то есть меняется ровно тогда, когда меняется
  тело: либо параметрами запроса, либо фоновым сканером.
- **path** — тег строится из `from`/`to` id (в порядке запроса — тело
  ассиметрично помечает "from"/"to", так что перестановка параметров
  местами валидна как отдельный кэш-ключ), маски ролей и `fetch_state`
  обоих концов пути.
- **search** — у эндпоинта нет персистентного состояния (Genius
  опрашивается вживую на каждый вызов), поэтому тег строится из
  нормализованного query и фактически вернувшегося набора id кандидатов.

Повторный запрос с `If-None-Match: <тот же ETag>` получает `304 Not
Modified` с пустым телом вместо повторной сборки JSON. Общая логика
слабого сравнения (`ETagMatches`, разбор `If-None-Match` со списком через
запятую и `*`) вынесена в `libs/six-feat-core/src/http_cache.{hpp,cpp}`
и используется всеми тремя хендлерами — конкретная формула тега у каждого
своя, потому что зависит от разных данных.

Отдельно от кэширования: JSON-тела ошибок `graph`/`path`/`search`/`status`
(`SF-API-06`) содержат поле `request_id` — тот же id, что уже уходит в
заголовке `X-Request-Id` и в теги лога (`libs/six-feat-core/src/request_id.{hpp,cpp}
`EnsureRequestId`/`CurrentRequestId`). Поле добавлено только к телам
ошибок; формат успешных ответов не менялся.

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

- Для анонимных запросов действует пер-IP лимит с фиксированным окном (`PerIpRateLimit`, `libs/six-feat-core/include/six-feat-core/rate_limiter.hpp`); авторизованные пользователи его не задевают — они ограничены только собственной OAuth-квотой Genius.
- При превышении хэндлеры `graph`/`path`/`search` отвечают `429 {"error": "rate_limit_exceeded"}` с заголовком `Retry-After: 1`.
- Если 429 приходит от самого Genius API, `GeniusGateway` включает кулдаун по `Retry-After` из ответа Genius (лог `[Pipeline] 429 — activating cooldown for ...`, `libs/six-feat-core/src/resilience.{hpp,cpp}`) — на это время запросы к Genius приостанавливаются автоматически.

### БД недоступна / `/readyz` не проходит

- Строка подключения к PostgreSQL собирается `docker-entrypoint.sh` из `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` (и `DB_REPLICA_HOST`/`DB_REPLICA_PORT`, если заданы) в DSN и передаётся в `static_config.yaml` через `postgres-db-1.dbconnection` (`$db_connection_string`) — никогда не коммитится. Убедитесь, что сервис `postgres` из `docker-compose.yml` здоров (`depends_on: condition: service_healthy`) прежде чем разбираться с `/readyz`.
- Если в логах видите `WARNING ... FindPool ... There is no pool for slave, falling back to master` — начиная с фикса в `persistent_store.cpp` (`ReadHostType()`) это больше НЕ должно происходить постоянно в дефолтной конфигурации (без `DB_REPLICA_HOST` чтения сразу идут в `kMaster`, `kSlave` не запрашивается вовсе). Если предупреждение всё же видно — это либо кратковременный интервал сразу после того, как `DB_REPLICA_HOST` был впервые задан (Cluster ещё не завершил первый `pg_is_in_recovery()`-проб топологии, ~1с), либо признак того, что вы **осознанно** настраивали `DB_REPLICA_HOST` на реальный standby, который не поднялся/не прошёл healthcheck, либо переменные не попали в окружение контейнера. См. "Postgres cluster topology" выше.
- Готовность проверяется через `GET /readyz`: вызывает `PersistentStore::Ping()` и возвращает `503` с `{"status":"not_ready","checks":{"database":{"ok":false}}}`, если БД недоступна.

### Граф не рендерится в браузере

[SF-SEC-02] `front/index.html` больше не грузит `vis-network` с CDN (`unpkg.com`) — файл захостен локально: `front/vendor/vis-network.min.js` (пин версии `vis-network@9.1.9/standalone/umd/vis-network.min.js`), раздаётся сервисом `six-feat` по пути `/vendor/vis-network.min.js` (`handler-vendor-vis-network`, `services/six-feat/src/http/static_handler.hpp` — `StaticFileHandler`, тот же механизм, что и для `index.html`/`script.js`) и копируется в рантайм-образ отдельным `COPY` в `services/six-feat/Dockerfile`. Тег в `index.html` — простой same-origin `<script src="/vendor/vis-network.min.js"></script>`, без `integrity`/`crossorigin` (раньше — CDN с зафиксированным SRI-хешем; при расхождении версии на CDN с той, под которую посчитан хеш, браузер молча блокировал скрипт — `Failed to find a valid digest`, граф оставался пустым; теперь эта категория отказа исключена, версия зафиксирована самим содержимым файла в репозитории).

Если граф всё равно не рендерится — проверьте:
- Файл `front/vendor/vis-network.min.js` присутствует и не пуст (`git lfs`/чекаут не сломан).
- В образе он лежит по `/usr/share/six_feat/vendor/vis-network.min.js` (см. `Dockerfile`) и путь совпадает с `file-path` в `static_config.yaml`'s `handler-vendor-vis-network`.
- Консоль браузера не показывает 404 на `/vendor/vis-network.min.js` — значит либо `Dockerfile`'ный `COPY` не отработал, либо в `static_config.yaml` разъехались `path`.

Обновление версии: заменить `front/vendor/vis-network.min.js` на новый `standalone/umd/vis-network.min.js` из релиза `vis-network`, обновить версию в комментариях (`index.html`, `static_handler.hpp`) и пересобрать образ — никакого пересчёта `integrity`/SRI больше не требуется.