# ADR-0010: Разделение libs/six-feat-common на независимые STATIC-библиотеки

## Статус

Принято (SF-STR-05).

## Контекст

Изначально (ADR-0001) общий код был вынесен в монолитную
`libs/six-feat-common/` — единый `add_subdirectory()` с общим
`CMakeLists.txt`, который компилировал всё сразу: доменные типы, resilience,
Postgres-слой, HTTP-кэш, клиенты Genius, OAuth-хэндлеры. Это давало
рабочий изолированный код между сервисами, но с тремя проблемами:

1. **Over-link**: сервис без Postgres (`six-feat-genius-gateway`,
   `six-feat-auth`) всё равно линковал `userver::postgresql`, потому что
   `libs/six-feat-common` тянула все зависимости сразу.
2. **Include visibility**: `<six-feat-common/enrichment/prune_task.hpp>`
   был виден всем сервисам, хотя нужен только `six-feat-enrichment` — не
   было механизма контроля, какие части общего кода видит какой сервис.
3. **Build granularity**: изменение в `role_mask.cpp` (домен) вызывало
   перекомпиляцию всех файлов, включая `persistent_store.cpp` (storage) и
   `session_crypto.cpp` (auth), из-за единой CMake-цели.

## Решение

Разделить `libs/six-feat-common/` на семь независимых STATIC-библиотек,
каждая со своим `CMakeLists.txt`, `src/` и `include/`:

| Библиотека | Содержит | Зависимости |
|---|---|---|
| `libs/six-feat-domain` | `domain_types.hpp`, `role_mask.{hpp,cpp}` | zero |
| `libs/six-feat-core` | `resilience`, `rate_limit_store`, `request_id`, `http_cache`, `security_headers`, `internal_auth`, `internal_http`, `error_response` | userver::core |
| `libs/six-feat-storage` | `persistent_store`, `artist_repository`, `analytics` | userver::postgresql, +core, +domain |
| `libs/six-feat-genius` | `genius_gateway`, `genius_gateway_client` | userver::core, +core |
| `libs/six-feat-enrichment` | `enrichment_queue`, `enrichment_worker`, `prune_task` | userver::core, +core, +storage |
| `libs/six-feat-auth-lib` | `oauth_handler`, `session_crypto` | userver::core, OpenSSL, +http |
| `libs/six-feat-http` | `health_handler`, `readiness_common` | userver::core, +core |

Include path: `<six-feat-domain/domain_types.hpp>`,
`<six-feat-core/resilience.hpp>`, и т.д. — каждая библиотека устанавливает
свой `target_include_directories` через `include/six-feat-*/`.

Старая `libs/six-feat-common/` удалена. Каждый сервис линкует только то,
что реально использует, через `target_link_libraries(... PRIVATE
six_feat_domain six_feat_core six_feat_storage ...)`.

## Последствия

**Плюсы:**
- Fine-grained dependencies: `six-feat-genius-gateway` линкует только
  `six_feat_domain`, `six_feat_core`, `six_feat_genius` — без Postgres.
- Include isolation: сервис физически не может включить `<prune_task.hpp>`,
  если он не линкует `six_feat_enrichment`.
- Build cache: изменение в `domain/role_mask.cpp` пересобирает только
  `libsix_feat_domain.a` и те сервисы, что от неё зависят — а не всю
  кодовую базу.

**Минусы / цена:**
- 7 `CMakeLists.txt` вместо 1 — больше boilerplate, хотя сами файлы
  тривиальны (пара `add_library` + `target_link_libraries`).
- Циклические зависимости запрещены статикой C++: если двум библиотекам
  нужно друг от друга что-то действительно общее — место этому общему в
  `six-feat-core` или новой библиотеке, а не взаимная линковка.
- Старая ссылка `libs/six-feat-common/` остаётся в git-истории (через
  `git log --follow`), но физически удалена из дерева файлов.
