# C4 — Context (Release 0.8)

Часть [SF-DOC-04](../ROADMAP.md). Обоснование архитектурных решений — в
[docs/adr/](../adr/README.md), не здесь; это только карта "кто с кем
разговаривает". Контейнерный уровень (что внутри SixFeat platform) — в
[c4-container.md](./c4-container.md). Конкретные протоколы отдельных
операций — в [sequences/](./sequences/).

## Диаграмма

Палитра — токены `front/src/styles/tokens.css` (тёмная тема): `--ink`
(фон), `--panel-2`/`--line` (карточки/границы), `--signal` (SixFeat
platform/GAME — тот же цвет, что и основной акцент фронтенда), `--pulse`
(пользователь), `--mist` (внешние системы) — не дефолтная C4-палитра.

```mermaid
%%{init: {
  "theme": "base",
  "themeVariables": {
    "background": "#0B0E14",
    "primaryColor": "#1B2236",
    "primaryTextColor": "#EDEFF4",
    "primaryBorderColor": "#283044",
    "lineColor": "#8A94A6",
    "secondaryColor": "#1B2236",
    "tertiaryColor": "#141A28",
    "edgeLabelBackground": "#141A28",
    "fontFamily": "Inter, system-ui, sans-serif"
  }
}}%%
flowchart TB
    user(["`👤 **Пользователь**
Строит граф коллабораций, ищет кратчайший путь между артистами, играет в игровой режим`"])

    sixfeat["`**SixFeat platform**
*«system»*
Граф коллабораций артистов: поиск, построение графа, кратчайший путь, кэш, фоновое обогащение, OAuth-сессия (ADR-0001/0002/0003/0004)`"]

    game["`**SixFeat GAME**
*«system»*
Игровой режим «собери цепочку» — отдельный сервис (ADR-0007), переиспользует движок графа фронтенда (ADR-0008), анти-чит сверяется с SixFeat platform через internal-mesh`"]

    genius["`**Genius API**
*«external system»*
api.genius.com — артисты, треки, кредиты (роли), OAuth Authorization Code`"]

    yandex["`**Яндекс.Музыка**
*«external system»*
Неофициальный, реверс-инженеренный API — co-appearance артистов на треке (роль всегда «feature»); дефолтный источник рёбер графа с Release 0.8 (SF-YM-01/SF-ARCH-02)`"]

    user -->|"Ищет/строит граф, смотрит путь<br/>HTTPS"| sixfeat
    user -->|"Играет ежедневный челлендж<br/>HTTPS"| game
    game -->|"Анти-чит: реальные соседи узла<br/>internal-mesh HTTP, X-Internal-Secret"| sixfeat
    sixfeat -->|"Артисты/треки/кредиты; OAuth-обмен кода на токен<br/>HTTPS"| genius
    sixfeat -->|"Co-appearance артистов на треке, сервисный токен<br/>HTTPS (реверс-инж.)"| yandex

    classDef person fill:#B98AFF,stroke:#8a5ee0,color:#07120F,stroke-width:2px
    classDef system fill:#1B2236,stroke:#5EE6C5,color:#EDEFF4,stroke-width:2px
    classDef ext fill:#141A28,stroke:#8A94A6,color:#8A94A6,stroke-width:1px

    class user person
    class sixfeat,game system
    class genius,yandex ext
```

## Ключевые решения, отражённые здесь

- **Единственный канонический ключ артиста — реальный Genius id**, у обеих
  систем (SixFeat platform и GAME) и у обоих внешних источников рёбер
  (Genius, Яндекс.Музыка) — ни у кого нет своего второго id-пространства.
  См. [ADR-0009](../adr/0009-canonical-artist-identity-in-game.md) и
  [ADR-0011](../adr/0011-music-source-provider-abstraction.md).
- **GAME — отдельная System**, а не контейнер внутри SixFeat platform: у
  неё свой собственный публичный HTTP-контракт
  (`/api/v1/game/*`, через nginx — см. [c4-container.md](./c4-container.md))
  и своя причина существования (ADR-0007), но она структурно зависит от
  SixFeat platform для анти-чита — тот же паттерн, что "другая система в
  ландшафте", а не подсистема.
- **Яндекс.Музыка теперь foundational, а не "когда-нибудь"**: с Release 0.8
  (SF-YM-01, SF-ARCH-02) это дефолтный, обязательный источник рёбер
  дефолтного графа — не опциональное дополнение. Genius остаётся
  источником сидов/резолва артистов, углубления по ролям (producer/writer/
  featured) и fallback при недоступности Яндекса.
