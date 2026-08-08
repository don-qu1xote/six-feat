# Sequence — фоновое обогащение чужим Genius-ключом (BYO-токен)

Часть [SF-DOC-04](../../ROADMAP.md).

**Статус: план (SF-YM-02, Release 1.0), не реализовано.** На момент
SF-DOC-04 `EnrichmentWorker` (`libs/six-feat-enrichment/src/enrichment_worker.cpp`)
использует только сервисный `GeniusGatewayClient`, таблицы
`user_provider_tokens` в коде ещё нет. Диаграмма фиксирует целевой поток
из `docs/ROADMAP.md` (SF-YM-02): "Подключение = согласие на фоновое
обогащение общей базы" — **явно и сознательно без отдельного шага
подтверждения**, см. примечание внизу. Обоснование провайдер-абстракции —
[ADR-0011](../../adr/0011-music-source-provider-abstraction.md).

## Диаграмма

```mermaid
sequenceDiagram
    autonumber
    actor Browser as Browser<br/>(Настройки)
    participant SixFeat as six-feat<br/>(планируемый settings-эндпоинт)
    participant Repo as Postgres<br/>(user_provider_tokens, зашифровано)
    participant Enrich as EnrichmentWorker<br/>(six-feat-enrichment)
    participant GeniusProv as MusicSourceProvider<br/>(Genius, BYO-токен)
    participant GeniusGw as six-feat-genius-gateway
    participant Genius as Genius API

    Browser->>Browser: вставляет свой Genius-токен в поле настроек
    Note over Browser,SixFeat: ПОДКЛЮЧЕНИЕ ТОКЕНА = СОГЛАСИЕ.<br/>Отдельного шага подтверждения "да, разрешаю обогащать общую базу" нет —<br/>сам факт вставки + сабмита токена и есть согласие (см. примечание внизу).
    Browser->>SixFeat: POST /api/v1/settings/genius-token {token}
    SixFeat->>SixFeat: encrypt(token) — паттерн session_crypto
    SixFeat->>Repo: UPSERT user_provider_tokens(user_id, provider='genius', encrypted_token)
    SixFeat-->>Browser: 200 "Genius-токен подключён — фоновое обогащение общей базы включено"

    Note over Enrich: Позже, асинхронно — EnrichmentQueue отдаёт pending-артиста
    Enrich->>Repo: найти usable BYO Genius-токен (политика выбора — TBD в SF-YM-02)
    Repo-->>Enrich: decrypted token (или ничего — тогда сервисный токен как раньше)
    Enrich->>GeniusProv: GetCollaborationEdges(seed, token=BYO)
    GeniusProv->>GeniusGw: FetchSongList + FetchSongDetail
    GeniusGw->>Genius: FG/BG-lane запросы (тот же CircuitBreaker/rate-limit, что у сервисного токена)
    Genius-->>GeniusGw: треки + кредиты (producer/writer/featured)
    GeniusGw-->>GeniusProv: SongRecord[]
    GeniusProv-->>Enrich: ProviderEdge[] (source=genius_credit)
    Enrich->>Repo: WriteThrough(ArtistSongs, Depth::Full) — L1/L2 кэш обновлён

    Note over Repo: Кэш общий — результат виден ВСЕМ пользователям,<br/>не только владельцу токена
```

## Что важно не потерять при чтении

- **"Подключение = согласие" — намеренное продуктовое решение, не
  недосмотр.** `docs/ROADMAP.md` (SF-YM-02) формулирует это прямо: "Строка
  текста ДО вставки токена" — то есть согласие достигается явным
  предупреждающим текстом рядом с полем ввода токена (что произойдёт после
  подключения), а не отдельным модальным окном/чекбоксом "я согласен"
  после отправки. Смысл: тот, кто вставляет свой Genius-токен, уже видел
  предупреждение — второй шаг подтверждения был бы дублирующим трением, а
  не дополнительной защитой.
- **Токен — shared resource, не изолированный.** Результат обогащения
  через чужой BYO-токен пишется в тот же общий L1/L2-кэш
  (`ArtistRepository`), который видят все пользователи — это осознанное
  свойство модели: подключая свой Genius-токен, пользователь соглашается
  обогащать общую базу, а не только свой собственный граф.
- **Шифрование — тот же паттерн, что `session_crypto`** (AES,
  ключ из `APP_SECRET`-подобного окружения) — токен не хранится в
  открытом виде в Postgres.
- Политика выбора "чей именно BYO-токен использовать, если их несколько" —
  сознательно не зафиксирована здесь (`TBD в SF-YM-02`); диаграмма
  документирует форму потока, а не ещё не принятое решение по этому
  конкретному вопросу.
