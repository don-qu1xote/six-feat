# Sequence — углубление по запросу ("найти больше связей")

Часть [SF-DOC-04](../../ROADMAP.md).

**Статус: план (SF-YM-03, Release 1.0), не реализовано.** Публичного
эндпоинта для этого потока в коде на момент SF-DOC-04 нет — сегодня
`MusicSourceProviderChain::GetCollaborationEdges` вызывается только с
internal-mesh observability-эндпоинта (см. примечание в
[build-default-graph.md](./build-default-graph.md)). Диаграмма фиксирует
целевую архитектуру потока, как описано в `docs/ROADMAP.md` (SF-YM-02,
SF-YM-03), чтобы решение было видно до реализации, а не только после.
Обоснование самой провайдер-абстракции — [ADR-0011](../../adr/0011-music-source-provider-abstraction.md).

## Диаграмма

```mermaid
sequenceDiagram
    autonumber
    actor Browser
    participant SixFeat as six-feat<br/>(планируемый эндпоинт "deepen")
    participant GeniusProv as GeniusMusicSourceProvider
    participant GeniusGw as six-feat-genius-gateway
    participant Genius as Genius API

    Note over Browser: Граф уже отрисован (дефолтные Genius-рёбра)
    Browser->>Browser: клик «Найти больше связей»
    Browser->>SixFeat: POST /api/v1/graph/deepen {seed}<br/>(+ BYO Genius-токен, если подключён — SF-YM-02)

    SixFeat->>GeniusProv: GetCollaborationEdges(seed, token=BYO ?? сервисный)
    Note right of GeniusProv: Приоритет BYO-токена пользователя,<br/>если он подключил свой Genius-токен (SF-YM-02)
    GeniusProv->>GeniusGw: FetchSongList + FetchSongDetail (роли: primary/producer/writer/featured)
    GeniusGw->>Genius: FG-lane запросы
    Genius-->>GeniusGw: треки + кредиты
    GeniusGw-->>GeniusProv: SongRecord[]
    GeniusProv-->>SixFeat: ProviderEdge[] (source=genius_credit)

    SixFeat->>SixFeat: Мёрж CollabEdge поверх уже отрисованного графа:<br/>дедуп по {from,to} — уже показанные рёбра не дублируются,<br/>только добавляются новые пары, найденные через BYO-токен<br/>с более щедрым rate-limit'ом, чем у сервисного
    SixFeat-->>Browser: 200 { new_nodes: [...], new_edges: [...] } — инкрементальный дельта-патч
    Browser->>Browser: домёржить дельту в уже отрисованный canvas (не перерисовывать граф с нуля)
```

## Что важно не потерять при чтении

- **Это углубление, не замена.** Рёбра, уже показанные пользователю,
  никуда не деваются — «найти больше связей» добавляет пары, которые
  дефолтный проход не успел найти (лимит `songs_limit` на
  foreground-запрос) или которые сервисный токен не смог получить из-за
  общего rate-limit'а с остальными пользователями.
- **BYO-токен — приоритет, не обязательность.** Работает и без него (на
  сервисном/дефолтном токене), просто ограничен обычными rate-limit'ами
  `six-feat-genius-gateway`, разделяемыми со всеми остальными
  пользователями без своего токена.
- **Идентичность не меняется.** Как и в `build-default-graph.md` — каждое
  новое ребро уже на реальных Genius id; артист, который не резолвится, в
  дельту просто не попадает (та же честная семантика "не найдено", что и
  у дефолтного графа).
