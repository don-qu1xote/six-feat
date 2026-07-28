# ROADMAP — реестр бэклога SixFeat

Этот файл — единый источник правды о том, что было сделано, в каком
порядке и почему, а также что запланировано в релизах 0.5–1.0. Сделанное
описано в формате реестра (§2), запланированное — в формате релиз-плана (§3).

---

## 1. Система нумерации

### 1.1. Тематическая ось — `SF-AREA-NN`

Каждая задача имеет постоянный тематический ID вида `SF-AREA-NN`, где
`AREA` — область системы, а `NN` — порядковый номер **внутри этой
области** (не полугода, не спринта — просто следующий свободный номер в
области). ID не переиспользуется и не меняется, даже если задачу потом
доработали три раза или откатили.

| AREA | Область | Примеры |
|---|---|---|
| `API` | HTTP-хендлеры `six-feat` — контракты, кэширование, авторизация | SF-API-01, SF-API-14 |
| `WEB` | Фронтенд: `front/src/**`, `front/index.html` — UI/UX, канва, панели | SF-WEB-01 … SF-WEB-24 |
| `DB` | Хранилище, миграции, EXPLAIN | SF-DB-01, SF-DB-08 |
| `PERF` | Точечные оптимизации (бэкенд и фронт) | SF-PERF-01 … SF-PERF-04 |
| `SEC` | Security-харденинг | SF-SEC-01, SF-SEC-02 |
| `SCH` | JSON-схемы хендлеров/компонентов и кодген | SF-SCH-00 … SF-SCH-03 |
| `CI` | GitHub Actions, переиспользуемые workflow'ы | SF-CI-01, SF-CI-02 |
| `OBS` | Наблюдаемость: метрики, логи, мониторинг | SF-OBS-01, SF-OBS-05 |
| `INF` | Docker Compose, инфраструктура, backup/DR | SF-INF-01, SF-INF-08 |
| `DOC` | Документация, ADR, диаграммы | SF-DOC-02, SF-DOC-04 |
| `ARCH` | Архитектура платформы, слои, интерфейсы | SF-ARCH-01, SF-ARCH-02 |
| `YM` | Яндекс.Музыка интеграция (gateway + персонализация) | SF-YM-01 … SF-YM-04 |
| `TST` | Тестирование (unit, contract) | SF-TST-04 |
| `CFG` | Конфигурация, env-профили | SF-CFG-01, SF-CFG-02 |
| `STR` | Структурный рефакторинг (сборочная система, entrypoint'ы, либы) | SF-STR-01 … SF-STR-09 |

### 1.2. Слой спринтов — `Sx (шаг k/n)`

`SF-AREA-NN` — это **что** делается и в какой части системы. Он ничего не
говорит о **порядке исполнения** — задачи из разных областей и разных
времён могут перемежаться как угодно. Порядок исполнения задаёт отдельная,
не пересекающаяся с тематической, ось — спринт:

```
Спринт: Sx (шаг k/n)
```

`x` — номер спринта, `k/n` — шаг `k` из запланированных `n` в этом
спринте. Один тикет `SF-AREA-NN` может быть единственным шагом спринта или
одним из многих; один и тот же `SF-AREA-NN` в принципе может получить
доработку в более позднем спринте (см. `SF-PERF-03`, у которого есть и
исходная реализация, и отдельный хотфикс несколькими спринтами позже) —
тематический ID при этом не меняется.

Пример — спринт **S7** (аудит и харденинг API/DB перед докой), как он
восстанавливается из истории этой сессии:

| Шаг | ID | Тема |
|---|---|---|
| 1/6 | _нет данных_ | Заголовок тикета не сохранился до сжатия контекста сессии — по логу коммитов это могла быть подготовительная задача до `SF-API-04`. |
| 2/6 | `SF-API-04` _(предположительно)_ | ETag/Cache-Control/304 на `/api/v1/search` и `/api/v1/graph/path` |
| 3/6 | `SF-API-06` | `request_id` в JSON-телах ошибок |
| 4/6 | `SF-DB-04` | Аудит индексов — новый индекс не потребовался |
| 5/6 | `SF-DB-05` | Тест на паритет `kMigrations` ↔ `V*.sql` |
| 6/6 | `SF-DOC-02` | ROADMAP.md + README.md + DEVELOPMENT.md |

Шаг 1/6 честно помечен как неизвестный, а не выдуман — реестр ниже не
опирается на точность этой таблицы, она здесь только как иллюстрация
механики "спринт поверх тематической оси".

### 1.3. Оси типа и приоритета

**Тип** (`type`) — природа изменения:

| Тип | Значение |
|---|---|
| `feat` | Новая пользовательская возможность |
| `fix` | Исправление бага / регресса |
| `perf` | Оптимизация горячего пути без изменения поведения |
| `refactor` | Изменение структуры кода/схемы без изменения поведения |
| `test` | Только тесты/регресс-покрытие, без изменения продакшен-кода |
| `docs` | Документация |
| `sec` | Security-харденинг |
| `chore` | Инфраструктура, конфигурация, CI, не относящееся к продукту напрямую |

**Приоритет** (`P0`…`P3`) — насколько задача горит:

| Приоритет | Значение |
|---|---|
| `P0` | Блокер прод/CI — чинится вне очереди |
| `P1` | Важно в текущем спринте |
| `P2` | Плановая работа текущего спринта (по умолчанию) |
| `P3` | Можно отложить на следующий спринт без последствий |

Приоритет проставляется в заголовке тикета отправителем и в реестре ниже
указан только там, где он реально был виден агенту в тексте тикета; для
задач, чей исходный тикет не сохранился в истории сессии, стоит «—».

### 1.4. Формат коммита

```
[SF-AREA-NN] type: короткое summary в повелительном наклонении
```

Тип в коммите — тот же словарь, что в §1.3 (`feat`/`fix`/`perf`/…), но это
поле не всегда проставлялось исторически: часть коммитов в этом
репозитории — до принятия этого стандарта — используют только
`[SF-AREA-NN] Человекочитаемое summary` без явного `type:`. Реестр ниже
восстанавливает тип по содержимому диффа для таких записей.

---

## 2. Реестр выполненных задач

Столбец **Тест** указывает файл(ы), где лежит регресс-покрытие конкретно
этой задачи. Столбец **Файлы** — ключевые изменённые файлы, не исчерпывающий
список (полный список — `git log --name-only <hash>`).

### SF-API — HTTP-хендлеры `six-feat`

| ID | Спринт·шаг | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|---|
| SF-API-01 | — | refactor | — | done | `services/six-feat/src/api/v1/authenticated_handler_base.hpp` | — |
| SF-API-02 | — | test | — | done | — | `tests/test_api_auth_headers.py` |
| SF-API-04 | S7 · 2/6* | perf | — | done | `libs/six-feat-core/src/http_cache.{hpp,cpp}`, `graph_handler.cpp`, `path_handler.{cpp,hpp}`, `search_handler.cpp` | `tests/test_path.py::TestPathETag`, `tests/test_search.py::TestSearchETag` |
| SF-API-06 | S7 · 3/6 | refactor | P2 | done | `graph_handler.cpp`, `path_handler.cpp`, `search_handler.cpp`, `status_handler.cpp` | `tests/test_graph.py`, `tests/test_path.py`, `tests/test_search.py`, `tests/test_status.py` (классы `*RequestId`/`*ETag`) |
| SF-API-07 | — | fix | — | done (3 итерации) | `libs/six-feat-genius/src/genius_gateway.cpp`, `front/src/graph.js`, `front/src/state/helpers.js` | `tests/test_image_normalization.py` |
| ~~SF-API-8~~ | — | — | — | заменено `SF-WEB-02` | `tests/test_path.py` | — дубль/опечатка номера |

\* См. оговорку в §1.2 — точный шаг спринта для `SF-API-04` восстановлен по журналу выполнения.

### SF-WEB — фронтенд

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-WEB-01 | perf | — | done | `front/src/graph.js` (`mergeGraph`, `edgeKey`) | `front/src/graph.test.js` |
| SF-WEB-02 | feat | — | done | `front/src/api/api.js`, `front/src/ui/history.js` | `front/src/ui/history.test.js` |
| SF-WEB-03 | feat | — | done | `front/src/ui/sidebar.js` | `front/src/ui/sidebar.test.js` |
| SF-WEB-04 | feat | — | done | `front/src/ui/canvas-controls.js` | `front/src/ui/canvas-controls.test.js` |
| SF-WEB-05 | feat | — | done | `front/src/ui/canvas-controls.js` (`updateScanStatus`) | `front/src/ui/canvas-controls.test.js` |
| SF-WEB-07 | perf | — | done | `front/src/vis-adapter/physics.js` | `front/src/vis-adapter/physics.test.js`, `highlight.test.js` |
| SF-WEB-09 | feat | — | done | `front/src/vis-adapter/physics.js` | `front/src/vis-adapter/physics.test.js` |
| SF-WEB-10 | refactor | — | done | `front/src/ui/canvas-controls.js` | `front/src/ui/canvas-controls.test.js` |
| SF-WEB-11 | feat | — | done | `front/index.html` (дизайн-токены) | `tests/test_image_normalization.py` |
| SF-WEB-12 | refactor | — | done | `front/src/ui/sidebar.js`, `front/src/ui/modals.js` | `front/src/ui/sidebar.test.js`, `modals.test.js` |
| SF-WEB-13 | feat | — | done | `front/src/ui/theme.js` | `front/src/ui/theme.test.js` |
| SF-WEB-14 | refactor | — | done | `front/src/ui/canvas-controls.js`, `front/src/ui/sidebar.js` | `front/src/canvas-declutter.test.js` |
| SF-WEB-15 | feat | — | done | `front/src/vis-adapter/highlight.js` | `front/src/vis-adapter/highlight.test.js` |
| SF-WEB-17 | feat | — | done | `front/src/ui/path-result.js`, `front/src/vis-adapter/layout.js` | `front/src/ui/path-result.test.js`, `front/src/vis-adapter/layout.test.js` |
| SF-WEB-18 | feat | — | done | `front/src/vis-adapter/visuals.js` | `front/src/vis-adapter/visuals.test.js` |
| SF-WEB-21 | feat | — | **reverted** (см. SF-WEB-23) | `front/src/ui/command-palette.test.js`, `front/src/ui/modals.js` | — |
| SF-WEB-22 | feat | — | **reverted** (см. SF-WEB-23) | те же, что SF-WEB-21 | — |
| SF-WEB-23 | fix | — | done | откат SF-WEB-21/22 целиком | — |
| SF-WEB-24 | feat | — | done | `front/src/ui/docked-panel.js` | `front/src/ui/docked-panel.test.js` |

### SF-DB — хранилище

| ID | Спринт·шаг | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|---|
| SF-DB-01 | — | perf | — | done | `libs/six-feat-storage/src/persistent_store.cpp` (`UpsertImpl` → `UNNEST`) | `tests/test_upsert_batching.py` |
| SF-DB-03 | — | test | — | done | — | `tests/test_upsert_batching.py` |
| SF-DB-04 | S7 · 4/6 | perf | P2 | **audit-only** | — | — |
| SF-DB-05 | S7 · 5/6 | refactor | P2 | done | — (только тест) | `tests/test_migrations.py` |

### SF-PERF — точечные оптимизации

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-PERF-01 | perf | — | done | `services/six-feat/src/api/v1/graph_handler.cpp` (`edges.count()`) | `tests/test_graph.py::TestGraphGoldenNodeEdgeOrder` |
| SF-PERF-02 | perf | — | done | `libs/six-feat-domain/src/role_mask.cpp` (ASCII fast-path) | `tests/test_role_mask.py` |
| SF-PERF-03 | test | — | done, 1 хотфикс | `tests/test_graph.py` | `tests/test_graph.py::TestGraphGoldenNodeEdgeOrder` |
| SF-PERF-04 | perf | — | done | `nginx/default.conf.template` (gzip) | — |

### SF-SEC — security-харденинг

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-SEC-01 | sec | — | done | `libs/six-feat-auth-lib/src/session_crypto.cpp`, `services/six-feat/src/auth/app_secret_parity_checker.*` | `tests/test_app_secret_parity.py` |
| SF-SEC-02 | sec | — | done | `front/vendor/vis-network.min.js`, `services/six-feat/src/api/v1/static_handler.cpp` | `tests/test_static_handlers.py` |

### SF-SCH — схемы хендлеров/компонентов

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-SCH-00 | refactor | — | done | `schemas/handlers/**`, `cmake/EmbedSchema.cmake` | — |
| SF-SCH-01 | refactor | — | done, 3 фикса | `schemas/components/**` | — |
| SF-SCH-02 | refactor | — | done | `services/*/static_config.yaml` (YAML-якоря) | — |
| SF-SCH-03 | test | — | done | `scripts/verify-yaml-anchors.py` | (сам является тестом) |

### SF-CI / SF-OBS / SF-INF

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-CI-01 | chore | — | done | `.github/actions/setup/action.yml`, `.github/workflows/ci.yml` | (сам является CI) |
| SF-CI-02 | chore | — | done | `.github/workflows/ci.yml` | (сам является CI) |
| SF-OBS-01 | feat | — | done | `observability/prometheus/**`, `observability/grafana/**` | — |
| SF-OBS-02 | feat | — | done | `libs/six-feat-core/src/request_id.*` | `tests/test_trace_id.py` |
| SF-INF-01 | chore | — | done | `docker-compose.yml` | — |

### SF-DOC

| ID | Спринт·шаг | Тип | Приоритет | Статус | Файлы | Тест |
|---|---|---|---|---|---|---|
| SF-DOC-02 | S7 · 6/6 | docs | P2 | done | `ROADMAP.md`, `README.md`, `DEVELOPMENT.md` | — |
| SF-DOC-07 | — | docs | P2 | done | `DEVELOPMENT.md` (5-й сервис, раскладка исходников), `ROADMAP.md`, `docs/adr/README.md` | — |

### SF-GAME — игровой режим

| ID | Спринт·шаг | Тип | Приоритет | Статус | Файлы | Тест |
|---|---|---|---|---|---|---|
| SF-GAME-30 | Ф1 | refactor | P1 | done | `front/src/state/state.js` | `game-board.test.js`, `game-mode.test.js` |
| SF-GAME-31 | Ф1 | refactor | P1 | done | `front/src/vis-adapter/game-mode.js`, `events.js`, `index.js`, `game/game-board.js` | `front/src/vis-adapter/game-mode.test.js` |
| SF-GAME-32 | Ф1 | refactor | P1 | done | `front/src/game/connect{-store,-view,-actions}.js` | `connect-store.test.js`, `connect-view.test.js`, `connect.test.js` |
| SF-GAME-33 | Ф1 | ui | P2 | done | `front/src/styles/surfaces/game-screens.css`, `front/index.html`, `game-windows.js` | `connect-view.test.js`, `styles.test.js` |
| SF-GAME-34 | Ф2 | fix | P1 | done | `connect-store.js`, `game-board.js`, `connect-view.js`, `game-windows.js` | соответствующие тесты |
| SF-CI-04 | Ф3 | ci | P1 | done | `.github/workflows/ci.yml` | — |
| SF-GAME-35 | Ф3 | docs | P3 | done | `DEVELOPMENT.md` | — |
| SF-GAME-36 | Ф3 | test | P1 | done | `tests/test_game_submit.py`, `postgresql/migrations/game/V2__seed_achievements.sql` | `test_game_submit.py`, `test_game_migrations.py` |
| SF-API-11 | Ф4 | api | P2 | done | `schemas/openapi/openapi.json` (9 game-путей, 6 схем) | `tests/test_openapi.py` |
| SF-GAME-37 | Ф4 | ui | P2 | done | `front/src/game/game-windows.js` | `game-windows.test.js` |
| SF-GAME-38 | Ф4 | qa | P2 | **open** | — | визуальный проход (не headless) |

---

## 3. Релиз-план

### Release 0.5 — Environment Parity
_Трек: Infrastructure. Статус: готово._

SF-CFG-02 · Единый docker-compose для dev/staging/prod, паритет только через переменные.

---

### Release 0.6 — Release Pipeline
_Трек: Infrastructure. Статус: готово._

SF-CI-07 · CD: build → registry → staging → health → smoke → approval → prod → rollback.

---

### Release S-0 — Structural Foundation
_Трек: Refactor. Чистый рефакторинг без изменения поведения. Выполняется перед мёржем в main._

Проект перерос пет-стадию: `libs/` — один монолит, Dockerfile'ы копируют 80% кода, entrypoint'ы — 50%, нет «собрать всё одной командой». Добавление шестого сервиса (yandex-gateway, SF-YM-01) без этой фазы умножит дубликат, а не уменьшит.

---

#### SF-STR-01 · refactor · P0 — Общий entrypoint-скрипт
_▸ model: Haiku 4.5_

Создать `services/.base/docker-entrypoint-common.sh`. Вынести:
- `load_env_profile()` — загрузка ENV_PROFILE + fail-fast (сейчас скопирован во все 5 entrypoint'ов)
- `wait_for_postgres()` — ожидание готовности Postgres с таймаутом (сейчас в 3 entrypoint'ах)
- `build_db_connection_string()` — сборка multi-host DSN (сейчас в 3 entrypoint'ах)

Каждый `services/*/docker-entrypoint.sh` переписывается на `source` общего скрипта + только свои config_vars.yaml.

Тест: `docker compose config` всех профилей не меняется; `docker compose up` поднимается как раньше.

---

#### SF-STR-02 · refactor · P0 — CMake preset для сервисов
_▸ model: Haiku 4.5_

Создать `cmake/presets/service.cmake` с boilerplate:
```cmake
cmake_minimum_required(VERSION 3.22)
project(<NAME> CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
get_filename_component(SIX_FEAT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
find_package(userver COMPONENTS core postgresql REQUIRED)
find_package(OpenSSL REQUIRED)
include(${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake)
```

Все сервисы меняют первые ~12 строк на `include(../../cmake/presets/service.cmake)`.

Тест: `cmake --build build` каждого сервиса проходит без изменений.

---

#### SF-STR-03 · refactor · P0 — Корневой CMakeLists.txt
_▸ model: Haiku 4.5_

Создать `CMakeLists.txt` в корне репозитория. `cmake -S . -B build && cmake --build build` собирает все сервисы одной командой.

Каждый сервис по-прежнему собирается отдельно (`cd services/six-feat && cmake -S . -B build`).

_Зависит от: SF-STR-02, SF-STR-05._

---

#### SF-STR-04 · chore · P0 — Makefile
_▸ model: Haiku 4.5_

| Команда | Действие |
|---|---|
| `make build` | `cmake -S . -B build && cmake --build build -j$(nproc)` |
| `make test` | `pytest tests/ -v` |
| `make lint` | clang-tidy + ruff + eslint |
| `make fmt` | clang-format + ruff format + prettier |
| `make dev` | `docker compose up --build` |
| `make clean` | `rm -rf build && docker compose down -v` |

_Зависит от: SF-STR-03._

---

#### SF-STR-05 · refactor · P0 ✓ — Декомпозиция libs/six-feat-common
_▸ model: Opus 4.8_

Разделить монолитную `libs/six-feat-common/` на независимые STATIC-библиотеки:

| Библиотека | Содержит | Зависимости |
|---|---|---|
| `libs/six-feat-domain` | `domain_types.hpp`, `role_mask.{hpp,cpp}` | zero |
| `libs/six-feat-core` | `resilience`, `rate_limit_store`, `request_id`, `http_cache`, `security_headers`, `internal_auth`, `internal_http`, `error_response` | userver::core |
| `libs/six-feat-storage` | `persistent_store`, `artist_repository`, `analytics` | userver::postgresql, +core, +domain |
| `libs/six-feat-genius` | `genius_gateway`, `genius_gateway_client` | userver::core, +core |
| `libs/six-feat-enrichment` | `enrichment_queue`, `enrichment_worker`, `prune_task` | userver::core, +core, +storage |
| `libs/six-feat-auth-lib` | `oauth_handler`, `session_crypto` | userver::core, OpenSSL, +http |
| `libs/six-feat-http` | `health_handler`, `readiness_common` | userver::core, +core |

Include path: `<six-feat-domain/domain_types.hpp>`, `<six-feat-core/resilience.hpp>`, и т.д.

Старая `libs/six-feat-common/` удалена. Каждый сервис линкует только то, что нужно.

_(Выполнено.)_

---

#### SF-STR-06 · refactor · P0 — Единообразная структура сервисов
_▸ model: Haiku 4.5_

1. Создать `services/.base/Dockerfile.shared` — общий builder + runtime base stage:
   - FROM USERVER_IMAGE AS builder
   - apt-get install libssl-dev
   - COPY cmake schemas libs
   - CCACHE_DIR + build cache
   - FROM ubuntu:22.04 AS runtime
   - apt-get install (весь список из 20 пакетов — один раз)
   - groupadd/useradd six_feat
   - HEALTHCHECK-шаблон

   Каждый сервисный Dockerfile — ~15 строк.

2. Нормализовать директории всех сервисов:
```
services/<name>/
├── src/
│   ├── main.cpp
│   ├── handlers/       # HTTP handlers
│   ├── components/     # service-specific компоненты
│   └── internal/       # internal-mesh хендлеры
├── CMakeLists.txt       # ~20 строк
├── Dockerfile            # ~15 строк
├── docker-entrypoint.sh  # ~20 строк
├── static_config.yaml
└── config_vars.yaml
```

3. Переименовать `services/enrichment/` → `services/six-feat-enrichment/` для единообразия.

_Зависит от: SF-STR-01, SF-STR-02, SF-STR-05._

---

#### SF-STR-07 · refactor · P0 — Слои application/infrastructure в six-feat
_▸ model: Opus 4.8_

Переложить `services/six-feat/src/`:
```
services/six-feat/src/
├── main.cpp
├── application/
│   └── collab_service.{hpp,cpp}
├── infrastructure/
│   ├── enrichment_client.{hpp,cpp}
│   └── genius_error_mapping.{hpp,cpp}
├── api/
│   └── v1/                                  # /api/v1/* handlers
│       ├── authenticated_handler_base.hpp
│       ├── artist_handler.{hpp,cpp}
│       ├── graph_handler.{hpp,cpp}
│       ├── path_handler.{hpp,cpp}
│       ├── search_handler.{hpp,cpp}
│       ├── status_handler.{hpp,cpp}
│       ├── sse_status_handler.{hpp,cpp}
│       ├── image_proxy_handler.{hpp,cpp}
│       └── static_handler.{hpp,cpp}
├── internal/                                # /internal/* handlers
│   └── neighbours_handler.{hpp,cpp}
├── system/                                  # /healthz, /readyz
│   └── readiness_handler.{hpp,cpp}
├── auth/
│   └── app_secret_parity_checker.{hpp,cpp}
└── token_router.hpp
```

_Зависит от: SF-STR-05 (библиотеки)._

---

#### SF-STR-08 · docs · P1 — Обновить документацию
_▸ model: Haiku 4.5_

- `DEVELOPMENT.md` — новая структура сервисов, библиотек, системы сборки
- ADR-0001 — дополнить (теперь 6 сервисов, не 4)
- Новый ADR о разделении библиотек и единой инфраструктуре сборки
- Обновить комментарии в CMakeLists.txt, entrypoint'ах, Dockerfile'ах

_Зависит от: SF-STR-05, SF-STR-06, SF-STR-07._

---

#### SF-STR-09 · chore · P1 — Полный pyproject.toml
_▸ model: Haiku 4.5_

Добавить `[tool.pytest.ini_options]` в существующий `pyproject.toml`:
```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
markers = [
    "bg_profile: runs with enrichment background profile",
    "game_profile: runs with game component profile",
    "rate_limit_store: runs with rate-limit-store profile",
    "slow: integration test that takes longer than 30s",
]
```

---

### Release 0.7 — Operational Readiness
_Трек: Infrastructure. Ни одного pg_dump/pg_restore, ни одного backup-скрипта, ни одного runbook. Alert-правила уже есть (SF-OBS-04) — это реакция на сбой, здесь — восстановление ПОСЛЕ потери данных._

---

#### SF-INF-08 · infra · P1 — Автоматический backup PostgreSQL + восстановление
_Release: 0.7 (шаг 1/4). ▸ model: Opus 4.8_

Read-реплика (SF-INF-02) защищает от нагрузки, не от потери данных. Проверено: ни одного backup/restore-скрипта, ни одного упоминания pg_dump/pg_restore.

Сделай:
1. `scripts/backup-postgres.sh` — pg_dump (custom format, -Fc) по расписанию (cron-контейнер в compose, профиль staging/prod), ротация N последних бэкапов (переменная окружения, дефолт 7), выгрузка в примонтированный volume или S3-совместимый endpoint (конфигурируемо, не хардкод провайдера).
2. `scripts/restore-postgres.sh` — обратная операция, требует `--yes-i-am-sure`.
3. Документируй ожидаемые RPO/RTO в DEVELOPMENT.md — честные числа исходя из частоты backup и объёма БД.

Тест (pytest, против тестовой БД): backup создаёт файл; restore на чистую БД воспроизводит те же строки (round-trip); ротация не хранит больше N файлов.

---

#### SF-INF-09 · infra · P2 — Disaster recovery runbook + автоматический drill
_Release: 0.7 (шаг 2/4). Опирается на: SF-INF-08. ▸ model: Sonnet 5_

Backup без периодической проверки восстановления — это театр, не готовность.

Сделай:
1. `docs/runbooks/disaster-recovery.md` — пошаговый ранбук: что делать при потере Postgres (кто оповещается, откуда взять последний backup, команда restore, как проверить целостность, кто даёт go/no-go на возврат трафика).
2. `scripts/dr-drill.py` — автоматический прогон: поднимает чистый Postgres в контейнере, восстанавливает из последнего реального backup, гоняет health-check + smoke-тест, публикует pass/fail.

Тест — сам является тестом; drill проходит на текущем baseline-backup; явно fail'ится при битых/неполных данных.

---

#### SF-OBS-05 · infra · P2 — Ротация логов (max-size/max-file)
_Release: 0.7 (шаг 3/4). Опирается на: SF-OBS-03. ▸ model: Haiku 4.5_

Пробел — логи растут неограниченно; диск staging/prod рано или поздно забивается.

Сделай: docker-compose logging-driver с явным max-size/max-file (json-file driver — options: max-size, max-file) на каждом сервисе — тот же паттерн, что hardening-якорь `&hardening`. Задокументируй ожидаемый максимум диска под логи на инстанс в DEVELOPMENT.md.

Тест: `docker compose config` показывает logging-опции на всех сервисах; синтетический тест (N MB логов) подтверждает ротацию.

---

#### SF-OBS-06 · infra · P2 — Внешний uptime/synthetic-мониторинг
_Release: 0.7 (шаг 4/4). ▸ model: Sonnet 5_

Prometheus (SF-OBS-01) видит метрики ИЗНУТРИ кластера. Alert-правила (SF-OBS-04) реагируют на то, что видно изнутри. Нужен независимый внешний пробник.

Сделай: scheduled workflow (GitHub Actions, cron, 5 мин) или blackbox-exporter (sidecar в compose) — опрашивает публичный `/api/v1/health` СНАРУЖИ, алертит при N последовательных провалах (порог, не единичный таймаут).

Тест: пробник детектирует down (мок — недоступный URL) и up (мок — 200 OK); не алертит на единичный таймаут.

---

### Release 0.8 — Platform Core
_Трек: Platform. Яндекс — обязательный дефолтный источник рёбер графа, Genius — углубление + fallback (ПРАВКА 2026-07-27). Инфраструктурные релизы (0.5–0.7) логически предшествуют этому._

---

#### SF-ARCH-01 · refactor · P1 — Слои core/application/infrastructure + граница интерфейсов
_Release: 0.8 (шаг 1/4). ▸ model: Opus 4.8_

Сейчас CollabService напрямую держит `ArtistRepository&` и `GeniusGatewayClient&` как конкретные типы — оркестрация, доступ к данным и внешний клиент не разделены.

Сделай (БЕЗ изменения поведения):
1. Явно размечен слой: `domain` (не трогать), `application` (CollabService), `infrastructure` (ArtistRepository, GeniusGatewayClient, EnrichmentClient).
2. Абстрактные интерфейсы: `IArtistDataSource` и `IExternalArtistLookup` — чистые виртуальные, zero userver-зависимостей.
3. `ArtistRepository`/`GeniusGatewayClient` остаются userver-компонентами, но ДОПОЛНИТЕЛЬНО реализуют эти интерфейсы. `CollabService` принимает ссылки на интерфейсы.

Тест: компиляция проходит; существующий регресс-набор (test_graph.py, test_path.py, test_search.py) зелёный.

---

#### SF-YM-01 · infra · P1 — Каркас yandex-gateway + сервисный токен + device-flow (задел)
_Release: 0.8 (шаг 2/4). ▸ model: Opus 4.8_

Яндекс.Музыка не имеет официального API — только реверс-инженеренные библиотеки. Изолируй хрупкость отдельным сервисом.

Сделай: `services/yandex-gateway/` по образцу `services/genius-gateway/`. Два режима:
1. **Сервисный токен** (обязательный) — один Яндекс OAuth-токен на SixFeat. Внутренние ручки: `/internal/yandex/{track-artists, search-artist}`.
2. **Device Flow** (задел) — пользовательский OAuth для SF-YM-04. Ручки: `/internal/yandex/{playlists, liked-tracks}`.

Circuit-breaker + rate-lane на обоих режимах. Compose: `<<: *hardening`, prometheus scrape-таргет. READ-ONLY.

Тест (pytest, мок Яндекс-API): сервисный токен возвращает track-artists; device-flow обменивается; недоступность апстрима отдаёт ошибку.

---

#### SF-ARCH-02 · feat · P1 — MusicSourceProvider: Яндекс-дефолт + Genius-углубление/fallback
_Release: 0.8 (шаг 3/4). Опирается на: SF-ARCH-01, SF-YM-01. ▸ model: Opus 4.8_

Канонический ключ артиста — **реальный Genius id** (ADR-0009). Яндекс — дефолтный источник РЁБЕР (не сидов), Genius — углубление + fallback. НЕ вводить колонку/enum provider как альтернативный ключ.

Сделай:
1. Интерфейс `MusicSourceProvider` с `GetCollaborationEdges(seed) → vector<CollabEdge>`. `CollabEdge {from, to (Genius id), source, role}`.
2. `DiscoverySource` — enum на уровне API, НЕ на ArtistRef (ADR-0009).
3. `YandexMusicSourceProvider` — дефолтный провайдер поверх yandex-gateway. Сервисный токен.
4. `GeniusMusicSourceProvider` — обёртка над GeniusGatewayClient. Углубление + автоматический fallback.
5. Порядок провайдеров — конфигурируемый список в static_config.
6. БД: НИКАКОЙ новой колонки provider на artists/credits.

Тест: Яндекс отдаёт CollabEdge с role="feature"; при недоступности Яндекса Genius подхватывает; нерезолвящийся артист — явный «не найдено».

---

#### SF-TST-04 · test · P1 — Fake-репозиторий + unit-тесты бэка (без Postgres)
_Release: 0.8 (шаг 4/4). Опирается на: SF-ARCH-01. ▸ model: Opus 4.8_

0% тестов бэка изолированы — ВСЕ pytest поднимают реальный бинарник + Postgres. Интеграционные тесты не трогать — добавить быстрый слой снизу пирамиды.

Сделай:
1. In-memory `FakeArtistDataSource` без Postgres/userver.
2. gtest-таргет для CollabService с FakeArtistDataSource + два фейковых MusicSourceProvider (успешный Яндекс-фейк и падающий для fallback).
3. Быстрые тесты: ResolveSeed, FindPath BFS, edge-cases (пустой граф, seed==goal), fallback.
4. CI — отдельный шаг до интеграционных.

Тест — сам является тестом; собирается и проходит без Docker.

---

#### SF-CFG-01 · refactor · P2 — Env-профили (dev/staging/prod)
_Release: 0.8 (доп. шаг). ▸ model: Sonnet 5_

Пробел — нет системы профилей окружений. Различия dev/staging/prod заданы разрозненными дефолтами.

Сделай: `config/profiles/{dev,staging,prod}.env` (наследуют `.env.example`, переопределяют только то, что реально отличается). `docker-entrypoint.sh` подхватывает профиль по `ENV_PROFILE` (дефолт dev, fail-fast). Не менять текущие дефолты dev.

Тест: скрипт проверяет, что все три профиля парсятся и не конфликтуют с required-переменными compose.

---

#### SF-DOC-04 · docs · P2 — C4-диаграммы + sequence-диаграммы + ADR
_Release: 0.8 (доп. шаг). Опирается на: docs/adr/0001-0009. ▸ model: Opus 4.8 / Haiku 4.5_

Пробел — ни одного .puml/Mermaid-файла в репозитории. ADR 0001–0009 не переписывать.

Сделай:
1. `docs/architecture/c4-context.md` + `c4-container.md` (Mermaid C4): 6 сервисов + Postgres + nginx + yandex-gateway.
2. `docs/architecture/sequences/` (Mermaid sequenceDiagram): OAuth-логин, построение дефолтного графа (с fallback), углубление по запросу, фоновое обогащение.
3. Новые ADR: `0010-music-source-provider-abstraction.md` (Genius-id-only, Яндекс-дефолт, Genius-углубление), `0011-six-feat-as-sole-public-entry.md`.

Диаграммы в Mermaid, не картинки.

---

#### SF-DB-08 · perf · P3 — Автоматика EXPLAIN по горячим запросам
_Release: 0.8 (доп. шаг). ▸ model: Sonnet 5_

Пробел — нет автоматической проверки планов на регресс.

Сделай: `scripts/explain-hot-queries.py` — EXPLAIN (FORMAT JSON) по SongsForArtist, LoadNeighboursImpl, upsert-батчам. Парсит план, флагает Seq Scan там, где ожидается Index Scan. CI-шаг — предупреждение, не блокирует.

Тест — сам является тестом; находит целевые индексы в текущем плане (зелёный baseline).

---

### Release 0.9 — API Platform
_Трек: Platform. Контракты API — платформенная задача. Не дублировать: OpenAPI (SF-API-05), error-envelope (SF-API-11), request-id (SF-API-06), rate-limiting по IP (SF-SEC-04), внутренние контракт-тесты (SF-TST-01) — уже закрыто._

---

#### SF-API-14 · feat · P2 — Публичный API v1: DTO-контракт, six-feat как единственная точка входа
_Release: 0.9 (шаг 1/4). Опирается на: SF-ARCH-01/02. ▸ model: Opus 4.8_

Сделай:
1. Явный DTO-слой: `services/six-feat/src/http/dto/` — структуры, которые видит клиент, отдельно от domain_types.hpp.
2. `source`-поле на каждом ребре в ответах graph (YandexFeature | GeniusCredit).
3. OpenAPI (расширить под новые ручки настроек/Яндекс из SF-YM-02/03/04).

Тест: OpenAPI валиден; существующие ответы байт-в-байт не изменились.

---

#### SF-API-15 · feat · P2 — API-ключи для сторонних потребителей
_Release: 0.9 (шаг 2/4). Опирается на: SF-API-14. ▸ model: Opus 4.8_

Сейчас единственная авторизация — сессионная cookie. У стороннего разработчика нет способа обратиться к API.

Сделай:
1. Таблица `api_keys` (key_hash, owner, rate_tier) — хеш ключа.
2. Middleware: X-Api-Key ИЛИ сессионная cookie → один CollabService.
3. Rate-limit per API-key (расширение RateLimitStore).
4. Ручка выпуска/отзыва ключа (за сессионной авторизацией).

Тест: валидный ключ проходит без cookie; невалидный/отозванный — 401; per-key rate-limit.

---

#### SF-API-16 · feat · P2 — Idempotency-Key на мутирующих ручках
_Release: 0.9 (шаг 3/4). Опирается на: SF-API-14. ▸ model: Sonnet 5_

Общего механизма идемпотентности для публичного API нет.

Сделай: обобщённый хелпер — Idempotency-Key на POST/PUT публичного API. Первый запрос кэширует результат (TTL 24ч); повторный возвращает закэшированный ответ.

Тест: два POST с одним ключом = один побочный эффект; разные ключи — независимые.

---

#### SF-API-18 · test · P2 — Contract-тесты публичного API v1
_Release: 0.9 (шаг 4/4). Опирается на: SF-API-05, SF-TST-01. ▸ model: Sonnet 5_

Сделай: pytest + jsonschema (property-based) против OpenAPI в CI, против реального six-feat. Ловит расхождение спецификация↔реализация.

Тест — сам является тестом; зелёный на текущем OpenAPI; падает при рассинхроне.

---

### Release 1.0 — Yandex Personalization
_Трек: Product. Персонализация поверх уже обязательного Яндекс-графа (Release 0.8)._

---

#### SF-YM-02 · feat · P2 — Экран настроек: свой Genius-токен + личный Яндекс-аккаунт
_Release: 1.0 (шаг 1/3). Опирается на: SF-YM-01, SF-ARCH-02. ▸ model: Sonnet 5 (front) / Opus 4.8 (back)_

Дефолтный граф уже работает на сервисном Яндекс-токене. Две отдельные опциональные персонализации:
1. **Свой Genius-токен** → углубление (producer/writer/featured). Подключение = согласие на фоновое обогащение общей базы. Строка текста ДО вставки токена.
2. **Свой Яндекс-аккаунт** → импорт плейлистов/лайков (SF-YM-04). Только личный опыт.

Бэк: таблица `user_provider_tokens` (user_id, provider, encrypted_token). Шифрование — паттерн session_crypto.
Фронт: раздельные карточки в настройках (по образцу SF-WEB-24).

Тест: оба токена шифруются/расшифровываются; Genius-токен доступен enrichment немедленно; личный Яндекс-токен НЕ используется для дефолтного графа других.

---

#### SF-YM-03 · feat · P2 — «Найти больше связей»: Genius-углубление по запросу
_Release: 1.0 (шаг 2/3). Опирается на: SF-YM-02, SF-ARCH-02. ▸ model: Opus 4.8_

Пользователь смотрит граф (Яндекс-рёбра). Кнопка «Find more connections via Genius» → GeniusMusicSourceProvider → CollabEdge с producer/writer/featured. Мёрж поверх существующих Яндекс-рёбер без дублирования. Приоритет BYO-токена.

Тест: запрос углубления добавляет рёбра с верными ролями, не дублирует Яндекс-рёбра; работает с BYO и без.

---

#### SF-YM-04 · feat · P3 — Импорт плейлистов/лайков → seed-подсказки
_Release: 1.0 (шаг 3/3). Опирается на: SF-YM-02, SF-YM-01. ▸ model: Opus 4.8_

Читает плейлисты/лайки через yandex-gateway (личный OAuth). Резолвит в Genius-id через существующий ResolveSeed. Нерезолвящийся артист — честная запись «не найден».

Фронт: «Import my Yandex playlists» → список → выбор → артисты как seed-кандидаты.

Тест: N артистов → M резолвленных, N−M помечены «не найден»; граф по резолвленному id идентичен обычному поиску.

---

## 4. Маппинг легаси `IDEA-N`

До появления схемы `SF-AREA-NN` дизайн-решения помечались `IDEA-N` в комментариях кода (`// [IDEA-32] …`).

- **Прямое переименование.** `IDEA-54` (JSON Schema в YAML) = предок `SF-SCH-00`.
- **Живые дизайн-примечания.** Большинство `IDEA-N` — inline-обоснования решений, не самостоятельные пункты бэклога.
- **Что делать, если нашли `IDEA-N` без контекста.** `grep -rn "IDEA-N\]" .` — комментарий рядом почти всегда объясняет решение.

---

## 5. Известные пробелы реестра

- Шаг `1/6` спринта S7 не восстановлен (§1.2).
- Приоритет в §2 указан только для задач, чей текст тикета был виден агенту; остальные — «—».
- `SF-PERF-04` (gzip в nginx) не имеет автоматизированного теста.
- Регистр строится по `git log` одной ветки
  (`claude/sf-web-03-companion-songs`, основанной на `origin/melidadr`). Если в других ветках есть решённые `SF-AREA-NN` — перегенерировать после мержа.
- Все задачи с `Status = todo` в §3 — план, не выполнение. Реестр обновляется после мержа каждого тикета.
- `SF-STR-05` (декомпозиция библиотек) — самая крупная работа; может быть разбита на подшаги.
- `SF-OBS-06` рекомендуется через blackbox-exporter (уже в observability stack), не отдельный GitHub Actions workflow.

---

## 6. Бэклог (P3, не запланировано в текущий релиз-трек)

Ничего из этого не в работе сейчас — просто список известного, что не забыто, но не попало в Release 0.5–1.0.

| ID | Тип | Задача | Опирается на | Примечание |
|---|---|---|---|---|
| SF-CI-04 | infra | ccache + матрица сборки по сервисам | SF-CI-01 | ускорение CI, 6-й сервис (+yandex-gateway) |
| SF-SCH-04 | refactor | Единый сборщик DSN/env в docker-entrypoint.sh | — | теперь 6 сервисов |
| SF-TST-02 | test | Расширить e2e Playwright под новые фичи | — | — |
| SF-TST-03 | test | Property/fuzz-тесты анти-чита | — | часть уже вошла в SF-GAME-20 на melidadr |
| SF-SEC-06 | sec | mTLS/ротация секрета внутренней сети | SF-INF-03 | net-new |
| SF-DB-07 | perf | Партиционирование/ретеншн game_attempts | — | net-new, при росте объёма |
| SF-API-10 | feat | Курсорная пагинация как общий хелпер | — | поднять приоритет при Release 0.9 |
| SF-WEB-26 | refactor | Зрелость клиентского стора (единый State + подписки) | — | net-new |
| SF-WEB-35 | feat | Адаптив компаньона + canvas-controls (нижний лист, тач ≥44px) | — | предложение агента |
| SF-GAME-06 | feat | Импорт артистов из Spotify — отдельный OAuth-провайдер | — | будущая веха |

Отклонено (осознанно, не пересматриваем): SF-API-09 (год/дата релиза на артисте) — перегружает бэкенд ради косметики.

---

*Последнее обновление реестра: `SF-DOC-04` — дорожная карта релизов S-0, 0.7, 0.8, 0.9, 1.0.*
