# ROADMAP — реестр бэклога SixFeat

Этот файл — единый источник правды о том, что было сделано, в каком
порядке и почему. Он существует, потому что бэклог живёт в двух местах
одновременно (тикеты, которые присылают разработчику, и `git log`, который
реально показывает, что применилось) и эти два места имеют свойство
расходиться. Регистр ниже собран из `git log` этого репозитория — то есть
отражает то, что **реально закоммичено**, а не то, что когда-то
планировалось.

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
| `API` | HTTP-хендлеры `six-feat` (`graph`, `path`, `search`, `status`) — контракты, кэширование, авторизация | SF-API-01, SF-API-04, SF-API-06 |
| `WEB` | Фронтенд: `front/src/**`, `front/index.html` — UI/UX, канва, панели | SF-WEB-01 … SF-WEB-24 |
| `DB` | `libs/six-feat-common/src/storage/**`, `postgresql/migrations/**` — схема, индексы, батчинг | SF-DB-01, SF-DB-04, SF-DB-05 |
| `PERF` | Точечные оптимизации горячих путей (бэкенд и фронт), не привязанные к одному хендлеру | SF-PERF-01 … SF-PERF-04 |
| `SEC` | Security-хардening: секреты, самохостинг зависимостей, целостность сессии | SF-SEC-01, SF-SEC-02 |
| `SCH` | Инфраструктура JSON-схем хендлеров/компонентов и кодгена | SF-SCH-00 … SF-SCH-03 |
| `CI` | GitHub Actions, переиспользуемые workflow'ы | SF-CI-01, SF-CI-02 |
| `OBS` | Наблюдаемость: метрики, трассировка | SF-OBS-01, SF-OBS-02 |
| `INF` | Docker Compose / инфраструктурные якоря, не относящиеся к конкретному сервису | SF-INF-01 |
| `DOC` | Документация репозитория | SF-DOC-02 (этот файл) |

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

Пример — спринт **S7** (аудит и хардening API/DB перед докой), как он
восстанавливается из истории этой сессии:

| Шаг | ID | Тема |
|---|---|---|
| 1/6 | *нет данных* | Заголовок тикета не сохранился до сжатия контекста сессии — по логу коммитов это могла быть подготовительная задача до `SF-API-04`. |
| 2/6 | `SF-API-04` *(предположительно)* | ETag/Cache-Control/304 на `/api/v1/search` и `/api/v1/graph/path` |
| 3/6 | `SF-API-06` | `request_id` в JSON-телах ошибок (`graph`/`path`/`search`/`status`) |
| 4/6 | `SF-DB-04` | Аудит индексов `SongsForArtist`/`LoadNeighbours` — по итогам анализа новый индекс не потребовался (пустой diff) |
| 5/6 | `SF-DB-05` | Тест на паритет `kMigrations` ↔ `postgresql/migrations/V*.sql` |
| 6/6 | `SF-DOC-02` | Этот файл + актуализация README.md/DEVELOPMENT.md |

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
| `sec` | Security-хардening |
| `chore` | Инфраструктура, конфигурация, CI, не относящееся к продукту напрямую |

**Приоритет** (`P0`…`P3`) — насколько задача горит:

| Приоритет | Значение |
|---|---|
| `P0` | Блокер прод/CI — чинится вне очереди |
| `P1` | Важно в текущем спринте |
| `P2` | Плановая работа текущего спринта (по умолчанию для большинства тикетов этого реестра) |
| `P3` | Можно отложить на следующий спринт без последствий |

Приоритет проставляется в заголовке тикета отправителем и в реестре ниже
указан только там, где он реально был виден агенту в тексте тикета; для
задач, чей исходный тикет не сохранился в истории сессии, стоит «—»
(нет данных) — не выдумывается.

### 1.4. Формат коммита

```
[SF-AREA-NN] type: короткое summary в повелительном наклонении
```

Тип в коммите — тот же словарь, что в §1.3 (`feat`/`fix`/`perf`/…), но это
поле не всегда проставлялось исторически: часть коммитов в этом
репозитории — до принятия этого стандарта — используют только
`[SF-AREA-NN] Человекочитаемое summary` без явного `type:`. Реестр ниже
восстанавливает тип по содержимому диффа для таких записей и помечает его
как «выведено» в примечании, а не как заявленный автором.

---

## 2. Реестр задач

Столбец **Тест** указывает файл(ы), где лежит регресс-покрытие конкретно
этой задачи (не весь модуль, если модуль покрывается многими тикетами).
Столбец **Файлы** — ключевые изменённые файлы, не исчерпывающий список
(полный список — `git log --name-only <hash>`).

### SF-API — HTTP-хендлеры `six-feat`

| ID | Спринт·шаг | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|---|
| SF-API-01 | — | refactor | — | done | `services/six-feat/src/http/authenticated_handler_base.hpp` | — |
| SF-API-02 | — | test | — | done | — | `tests/test_api_auth_headers.py` |
| SF-API-04 | S7 · 2/6* | perf | — | done | `libs/six-feat-common/src/core/http_cache.{hpp,cpp}`, `graph_handler.cpp`, `path_handler.{cpp,hpp}`, `search_handler.cpp` | `tests/test_path.py::TestPathETag`, `tests/test_search.py::TestSearchETag` |
| SF-API-06 | S7 · 3/6 | refactor | P2 | done | `graph_handler.cpp`, `path_handler.cpp`, `search_handler.cpp`, `status_handler.cpp` | `tests/test_graph.py`, `tests/test_path.py`, `tests/test_search.py`, `tests/test_status.py` (классы `*RequestId`/`*ETag`) |
| SF-API-07 | — | fix | — | done (3 итерации) | `libs/six-feat-common/src/genius/genius_gateway.cpp`, `front/src/graph.js`, `front/src/state/helpers.js` | `tests/test_image_normalization.py` |
| ~~SF-API-8~~ | — | — | — | заменено `SF-WEB-02` | `tests/test_path.py` | — дубль/опечатка номера, содержательно та же задача ("Deep-link: полное состояние исследования"), переисполнена под корректным ID `SF-WEB-02` |

\* См. оговорку в §1.2 — точный шаг спринта для `SF-API-04` восстановлен по журналу выполнения, не по сохранённому заголовку тикета.

### SF-WEB — фронтенд

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-WEB-01 | perf | — | done | `front/src/graph.js` (`mergeGraph`, `edgeKey`) | `front/src/graph.test.js` |
| SF-WEB-02 | feat | — | done | `front/src/api/api.js`, `front/src/ui/history.js` | `front/src/ui/history.test.js` |
| SF-WEB-03 | feat | — | done | `front/src/ui/sidebar.js` | `front/src/ui/sidebar.test.js` |
| SF-WEB-04 | feat | — | done | `front/src/ui/canvas-controls.js` (`buildGraphExportData`/`exportGraphJson`) | `front/src/ui/canvas-controls.test.js` |
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
| SF-DB-01 | — | perf | — | done | `libs/six-feat-common/src/storage/persistent_store.cpp` (`UpsertImpl` → `UNNEST`) | `tests/test_upsert_batching.py` |
| SF-DB-03 | — | test | — | done | — | `tests/test_upsert_batching.py` |
| SF-DB-04 | S7 · 4/6 | perf | P2 | **audit-only** — недостающий индекс не найден, изменений нет (`SongsForArtist`/`LoadNeighboursImpl` уже полностью покрыты `idx_credits_artist`/`idx_credits_song`/PK `credits(song_id,artist_id,role)`) | — | — |
| SF-DB-05 | S7 · 5/6 | refactor | P2 | done | — (только тест) | `tests/test_migrations.py` |

### SF-PERF — точечные оптимизации

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-PERF-01 | perf | — | done | `services/six-feat/src/http/graph_handler.cpp` (`edges.count()` вместо `order_set`) | `tests/test_graph.py::TestGraphGoldenNodeEdgeOrder` |
| SF-PERF-02 | perf | — | done | `libs/six-feat-common/src/domain/role_mask.cpp` (`ToLower` ASCII fast-path) | `tests/test_role_mask.py` |
| SF-PERF-03 | test | — | done, 1 хотфикс | `tests/test_graph.py` (голден-тест на порядок nodes/edges) | `tests/test_graph.py::TestGraphGoldenNodeEdgeOrder` |
| SF-PERF-04 | perf | — | done | `nginx/default.conf.template` (gzip) | — (нет unit-теста конфигурации nginx; см. `TODO` ниже) |

### SF-SEC — security-хардening

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-SEC-01 | sec | — | done | `libs/six-feat-common/src/auth/session_crypto.cpp`, `services/six-feat/src/auth/app_secret_parity_checker.{cpp,hpp}` | `tests/test_app_secret_parity.py` |
| SF-SEC-02 | sec | — | done | `front/vendor/vis-network.min.js`, `services/six-feat/src/http/static_handler.cpp` | `tests/test_static_handlers.py` |

### SF-SCH — схемы хендлеров/компонентов

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-SCH-00 | refactor | — | done (наследник `IDEA-54`, см. §3) | `schemas/handlers/**`, `cmake/EmbedSchema.cmake` | — |
| SF-SCH-01 | refactor | — | done, 3 фикса | `schemas/components/**` | — |
| SF-SCH-02 | refactor | — | done | `services/*/static_config.yaml` (YAML-якоря) | — |
| SF-SCH-03 | test | — | done | `scripts/verify-yaml-anchors.py` | (сам является тестом) |

### SF-CI / SF-OBS / SF-INF

| ID | Тип | Приоритет | Статус | Файлы (ключевые) | Тест |
|---|---|---|---|---|---|
| SF-CI-01 | chore | — | done | `.github/actions/setup/action.yml`, `.github/workflows/ci.yml` | (сам является CI) |
| SF-CI-02 | chore | — | done | `.github/workflows/ci.yml` | (сам является CI) |
| SF-OBS-01 | feat | — | done | `observability/prometheus/**`, `observability/grafana/**` | — |
| SF-OBS-02 | feat | — | done, 1 фикс | `libs/six-feat-common/src/core/request_id.{cpp,hpp}` | `tests/test_trace_id.py` |
| SF-INF-01 | chore | — | done | `docker-compose.yml` | — |

### SF-DOC

| ID | Спринт·шаг | Тип | Приоритет | Статус | Файлы | Тест |
|---|---|---|---|---|---|---|
| SF-DOC-02 | S7 · 6/6 | docs | P2 | done | `ROADMAP.md` (новый), `README.md`, `DEVELOPMENT.md` | — (документация, регресс-теста не требует) |
| SF-DOC-07 | — | docs | P2 | done | `DEVELOPMENT.md` (пятый сервис в таблице + раскладка исходников SF-GAME-35), `ROADMAP.md`, `docs/adr/README.md` | — (документация) |

### SF-GAME — игровой режим

Бэкенд игры (`SF-GAME-10`…`SF-GAME-17`) и первый заход фронта делались до
введения этого раздела и живут в истории коммитов. Ниже — сброс геймификации:
приведение её к тем же стандартам, что и остальной сервис (аудит и план —
`docs/adr/0008`, `docs/adr/0009`).

| ID | Спринт·шаг | Тип | Приоритет | Статус | Файлы | Тест |
|---|---|---|---|---|---|---|
| SF-GAME-30 | Ф1 | refactor | P1 | done | `front/src/state/state.js` | `game-board.test.js`, `game-mode.test.js` |
| SF-GAME-31 | Ф1 | refactor | P1 | done | `front/src/vis-adapter/game-mode.js` (новый), `events.js`, `index.js`, `game/game-board.js` | `front/src/vis-adapter/game-mode.test.js` |
| SF-GAME-32 | Ф1 | refactor | P1 | done | `front/src/game/connect{,-store,-view,-actions}.js` | `connect-store.test.js`, `connect-view.test.js`, `connect.test.js` |
| SF-GAME-33 | Ф1 | ui | P2 | done | `front/src/styles/surfaces/game-screens.css`, `front/index.html`, `game-windows.js` | `connect-view.test.js` (ui-chip), `styles.test.js` |
| SF-GAME-34 | Ф2 | fix | P1 | done | `connect-store.js`, `game-board.js`, `connect-view.js`, `game-windows.js` | `connect-store.test.js`, `game-board.test.js`, `connect-view.test.js`, `game-windows.test.js` |
| SF-CI-04 | Ф3 | ci | P1 | done | `.github/workflows/ci.yml` | — (сам гейт CI) |
| SF-GAME-35 | Ф3 | docs | P3 | done | `DEVELOPMENT.md` («Раскладка исходников сервиса») | — (решение зафиксировано, не код) |
| SF-GAME-36 | Ф3 | test | P1 | done | `tests/test_game_submit.py`, `postgresql/migrations/game/V2__seed_achievements.sql` (недостающая копия) | `test_game_submit.py` (3 теста анти-абуза), `test_game_migrations.py` |
| SF-API-11 | Ф4 | api | P2 | done | `schemas/openapi/openapi.json` (9 game-путей, 6 схем) | `tests/test_openapi.py` |
| SF-GAME-37 | Ф4 | ui | P2 | done | `front/src/game/game-windows.js` (пусто ≠ недоступно) | `game-windows.test.js` |
| SF-GAME-38 | Ф4 | qa | P2 | **open** | — | Только вживую: физика/лэйаут/z-index графа не рендерятся в headless, нужен визуальный проход |

---

## 3. Маппинг легаси `IDEA-N`

До появления схемы `SF-AREA-NN` дизайн-решения в этом репозитории
помечались сквозной нумерацией `IDEA-N` прямо в комментариях кода (`// [IDEA-32] …`) —
без отдельного тикет-трекера и без записи в `git log` как отдельного
пункта бэклога. Тегов `IDEA-N` в кодовой базе на порядок больше, чем
`SF-AREA-NN` (комментарии живут там, где было принято решение, а не
переезжают при рефакторинге), поэтому ниже — не построчная таблица «что на
что заменилось» (она была бы придумана, а не восстановлена), а честная
классификация:

- **Прямое переименование.** Единственный случай, где переход
  зафиксирован в самой истории коммитов: `[IDEA-54] Вынести JSON Schema
  каждого хендлера из инлайн-R"(...)" в отдельные YAML-файлы` — три
  коммита под старым номером, затем тот же объём работы продолжен под
  `[SF-SCH-00] Схемы хендлеров → schemas/ + кодген`. `IDEA-54` = предок
  `SF-SCH-00`.

- **Живые дизайн-примечания.** Подавляющее большинство остальных тегов
  (`IDEA-17`, `IDEA-18`, `IDEA-22`, `IDEA-23`, `IDEA-32`, `IDEA-50` и
  далее — полный список получается через `grep -rn 'IDEA-[0-9]' --include=*.cpp --include=*.hpp --include=*.js`)
  никогда не были самостоятельными пунктами бэклога с отдельным статусом —
  это inline-обоснования конкретных решений (почему кэш-ключ устроен так,
  почему лимит такой), написанные один раз при реализации и оставленные в
  коде как контекст для следующего читателя. Они не требуют записи в
  реестр §2, потому что не являются задачами — они являются причиной,
  по которой какая-то задача из §2 сделана именно так.

- **Что делать, если нашли `IDEA-N` без ясного контекста.** `grep -rn
  "IDEA-N\]" .` — комментарий рядом с находкой почти всегда объясняет
  решение самостоятельно (это и есть их назначение). Если тег ссылается на
  функциональность, которая с тех пор получила `SF-AREA-NN` (например,
  `IDEA-32`/`IDEA-50` рядом с `BuildGraphETag` в `graph_handler.cpp` —
  прямой предшественник `SF-API-04`/`SF-API-06`), это указано в
  комментарии на месте, а не задваивается здесь.

---

## 4. Известные пробелы реестра (честно, а не молча)

- Шаг `1/6` спринта **S7** не восстановлен (§1.2) — заголовок тикета не
  пережил сжатие контекста сессии.
- Приоритет (`P0`…`P3`) в §2 указан только для задач, чей исходный текст
  тикета был виден агенту напрямую; остальные помечены «—», а не
  придуманным значением.
- `SF-PERF-04` (gzip в nginx) не имеет автоматизированного теста — в
  песочнице агента не было `nginx`/`envsubst`, конфиг был проверен только
  чтением; настоящая проверка (`nginx -t` + `curl -H 'Accept-Encoding:
  gzip'`) — открытый TODO для окружения с доступным Docker.
- Регистр строится по `git log` **одной** ветки
  (`claude/sf-web-03-companion-songs`, основанной на `origin/melidadr`).
  Если в других ветках есть решённые `SF-AREA-NN`, отсутствующие здесь —
  этот файл нужно перегенерировать после мержа, а не редактировать вручную
  построчно (иначе он повторит судьбу `postgresql/migrations/V*.sql`,
  которую чинит `SF-DB-05` — см. `tests/test_migrations.py`).

---

*Последнее обновление реестра: `SF-DOC-07` — сброс геймификации, фазы Ф0–Ф4.*