# Architecture Decision Records

ADR (Architecture Decision Record, формат Nygard) — короткие записи о
принятых архитектурных решениях: контекст, само решение, последствия
(плюсы и цена). Каждая ADR фиксирует **решение и его обоснование**, а не
хронологию работы над ним.

Это не замена истории работ: что и когда сделано — в `git log` по
префиксам `SF-AREA-NN` (см. [DEVELOPMENT.md](../DEVELOPMENT.md)), а куда
продукт идёт дальше — в [ROADMAP.md](../ROADMAP.md). Здесь — почему
решения приняты именно так, без привязки к тикетам. Если нужен ответ на
вопрос "почему так, а не иначе" — сюда.

## Индекс

| ADR | Заголовок | Статус |
|---|---|---|
| [0001](./0001-split-into-four-services.md) | Разбить six-feat на четыре независимых сервиса | Принято |
| [0002](./0002-enrichment-standalone-service.md) | Вынести фоновый глубокий скан в отдельный сервис six-feat-enrichment | Принято |
| [0003](./0003-genius-gateway-centralizes-rate-limiting.md) | Централизовать доступ к Genius API, CircuitBreaker и rate-limiting в six-feat-genius-gateway | Принято |
| [0004](./0004-auth-service-local-session-verification.md) | Вынести OAuth-флоу в six-feat-auth, но проверять сессию в six-feat локально | Принято |
| [0005](./0005-handler-schemas-yaml-codegen.md) | Вынести схемы хендлеров/компонентов в YAML и кодогенерировать заголовки | Принято |
| [0006](./0006-docker-compose-hardening-anchor.md) | Общий YAML-якорь хардненинга контейнеров в docker-compose.yml | Принято |
| [0007](./0007-game-mode-as-separate-service.md) | Выделение game в отдельный сервис | Принято |
| [0008](./0008-game-frontend-reuses-explorer-engine.md) | Игровой фронтенд рендерит на том же движке графа, что и Explorer | Принято |
| [0009](./0009-canonical-artist-identity-in-game.md) | Каноническая идентичность артиста в игре — реальный Genius id, без синтетических | Принято |
| [0010](./0010-library-split-and-unified-build.md) | Разделение libs/six-feat-common на независимые STATIC-библиотеки | Принято |
| [0011](./0011-music-source-provider-abstraction.md) | MusicSourceProvider: абстракция над источником рёбер графа | Принято (частично устарело — см. addendum) |
| [0012](./0012-six-feat-as-sole-public-entry.md) | six-feat остаётся основным публичным сервисом данных — без отдельного BFF | Принято |
| [0013](./0013-two-provider-artist-identity.md) | Namespaced Yandex artist id + artist_alias: Yandex-only граф без Genius | Архивный / Superseded |
| [0014](./0014-declarative-schema-instead-of-migrations.md) | Одна декларативная схема вместо версионированных миграций | Принято |
| [0015](./0015-single-test-contour-over-ctypes.md) | C++ проверяется из pytest через ctypes, gtest убран | Принято |

## Формат

Каждая ADR — короткий файл `NNNN-kebab-title.md` с разделами:

- **Статус** — Предложено / Принято / Устарело (и чем заменено, если
  устарело).
- **Контекст** — какая проблема решалась, какие были ограничения.
- **Решение** — что именно решили сделать.
- **Последствия** — плюсы и цена решения, честно, включая то, что оно
  не решает.

## Когда добавлять новую ADR

Когда решение архитектурное (влияет на границы сервисов, контракты между
ними, модель данных, или требует объяснения "почему не иначе" при
следующем чтении кода) — а не когда это рядовая фича или багфикс с
понятным обоснованием без него. Не каждый тикет заслуживает ADR;
большинство — нет.
