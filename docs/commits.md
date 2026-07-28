# Commit Convention — SixFeat

Формат коммита, основанный на практике из `git log` репозитория.

## Формат

```
[SF-AREA-NN] type: описание в повелительном наклонении
```

| Часть | Описание |
|---|---|
| `AREA` | Область системы (2–4 буквы) |
| `NN` | Порядковый номер внутри области (2 цифры, `00`–`99`) |
| `type` | Опционально: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `sec`, `chore` |
| `описание` | Коротко (до 72 символов), на русском или английском |

## Фиксы

| Суффикс | Значение |
|---|---|
| `[SF-AREA-NN fix]` | Первый фикс |
| `[SF-AREA-NN fix2]` | Второй фикс |
| `[SF-AREA-NN fix{N}]` | N-ный фикс |

Примеры из истории:
```
[SF-CI-08] Parallel CI with incremental change detection
[SF-CI-08 fix] Join split CREATE INDEX strings in game_store.cpp
[SF-CI-09] Fix bare-runner CI permissions and clang-format drift
[SF-CI-09 fix] Remove redundant parens in b64 char access
[SF-CI-10 fix] Исправить CI: clang-tidy, прометей, k6, frontend тесты
[SF-CI-10 fix2] Исправить clang-tidy: убрать warnings-as-errors из системных headers
```

## Области (AREA)

| AREA | Область |
|---|---|
| `API` | HTTP-хендлеры `six-feat` |
| `CFG` | Конфигурация, docker-compose |
| `CI` | GitHub Actions, CI |
| `CLN` | Очистка кода, исправление warnings |
| `DB` | Хранилище, миграции |
| `DOC` | Документация |
| `GAME` | Игровой режим |
| `INF` | Инфраструктура |
| `NN` | Разное (naming/nits) |
| `OBS` | Наблюдаемость |
| `PERF` | Оптимизации |
| `SCH` | Схемы |
| `SEC` | Security |
| `WEB` | Фронтенд |

## Принципы

- Один коммит = одна логическая единица работы.
- `SF-AREA-NN` не меняется и не переиспользуется (см. `ROADMAP.md §1.1`).
- Фиксы используют тот же `SF-AREA-NN`, что и основной коммит.
- Если коммит затрагивает несколько областей — выбирается основная.
