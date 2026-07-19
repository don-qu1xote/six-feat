# ADR-0003: Централизовать доступ к Genius API, CircuitBreaker и rate-limiting в six-feat-genius-gateway

## Статус

Принято (IDEA-45/46).

## Контекст

И `six_feat`, и `six-feat-enrichment` обращаются к Genius API — первый
для интерактивного поиска/графа (foreground lane), второй для фонового
глубокого скана (background lane). До этого решения `GeniusGateway`
(CircuitBreaker + FG/BG token-bucket rate-limiting) был in-process
компонентом, и каждый сервис держал свою собственную копию этого
состояния.

Проблема: у Genius API один общий лимит на приложение/токен независимо от
того, какой из наших процессов сделал запрос. Две независимые копии
CircuitBreaker/rate-limiter не координируются между собой — FG-трафик из
`six_feat` и BG-трафик из `six-feat-enrichment` могли вместе исчерпать
реальный лимит Genius, при этом каждый локальный breaker считал, что всё
в порядке, потому что видел только свою половину трафика.

## Решение

Вынести весь исходящий трафик к Genius в отдельный сервис
`six-feat-genius-gateway` (`services/genius-gateway/`, порт 8082) с
внутренним HTTP API:

```
POST /internal/genius/artist       {id, lane, user_token}
POST /internal/genius/song-list    {artist_id, limit, lane, user_token}
POST /internal/genius/song         {song_id, lane, user_token}
POST /internal/genius/candidates   {query, user_token}
```

Один инстанс — одно общее состояние CircuitBreaker и FG/BG lane
rate-limiter для ВСЕГО трафика к Genius, независимо от того, какой
внутренний сервис инициировал запрос. `six_feat` и
`six-feat-enrichment` теперь используют `GeniusGatewayClient`
(`libs/six-feat-common/src/genius/genius_gateway_client.hpp`) — тонкий,
stateless HTTP-клиент с тем же публичным интерфейсом, что был у старого
in-process `GeniusGateway` (`FetchArtistById`, `FetchSongList`,
`FetchSongDetail`, `ResolveCandidates`), так что `CollabService`,
`graph_handler`, `search_handler`, `EnrichmentWorker` не изменились по
сигнатурам вызова. Ответы не-2xx пробрасываются как тот же
`GeniusHttpError` с тем же статус-кодом, так что существующий маппинг
ошибок (`genius_error_mapping.cpp`, обработка 401 на переlogin) продолжил
работать без изменений.

Контракт between клиентской и серверной стороной зафиксирован
контракт-тестами (`tests/test_contract_gateway.py`, SF-TST-01) — до этого
он проверялся только косвенно, сквозными тестами графа/поиска.

## Последствия

**Плюсы:**
- Один источник истины для состояния CircuitBreaker/rate-limiter —
  никакой рассинхронизации между FG- и BG-трафиком.
- `six_feat`/`six-feat-enrichment` избавились от прямой зависимости на
  Genius API и HTTP-клиент к нему — стали чище, вся resilience-логика в
  одном месте.

**Минусы / цена:**
- Дополнительный сетевой хоп на каждый вызов к Genius (внутри доверенной
  сети, gated `X-Internal-Secret`).
- `six-feat-genius-gateway` — новая единая точка отказа для ВСЕГО доступа
  к Genius; смягчено мягкой зависимостью в `docker-compose.yml`
  (`condition: service_started`) и retry/CB на клиентской стороне,
  а не блокировкой старта вызывающих сервисов.
