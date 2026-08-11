# Диаграммы архитектуры

[SF-DOC-04](../ROADMAP.md). Диаграммы в Mermaid — рендерятся нативно на
GitHub и в большинстве вьюеров markdown, без картинок/plantuml-рендерера.

Обоснование решений — в [docs/adr/](../adr/README.md), не здесь: там
контекст/решение/последствия; здесь — только форма (кто с кем и как
разговаривает).

## C4

- [c4-context.md](./c4-context.md) — SixFeat platform / GAME / Genius /
  пользователь.
- [c4-container.md](./c4-container.md) — контейнеры внутри SixFeat
  platform: 5 сервисов, Postgres, nginx.

## Sequence

- [sequences/oauth-login.md](./sequences/oauth-login.md) — OAuth-логин
  (auth ↔ six-feat ↔ Genius). **Реализовано.**
- [sequences/build-default-graph.md](./sequences/build-default-graph.md) —
  построение дефолтного графа через Genius. **Реализовано.**
- [sequences/deepen-on-demand.md](./sequences/deepen-on-demand.md) —
  углубление по запросу через Genius. **План (SF-YM-03, Release 1.0).**
- [sequences/background-enrichment-byo-token.md](./sequences/background-enrichment-byo-token.md) —
  фоновое обогащение чужим Genius-ключом. **План (SF-YM-02, Release 1.0).**
