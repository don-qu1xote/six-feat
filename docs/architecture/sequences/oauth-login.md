# Sequence — OAuth-логин (auth ↔ six-feat ↔ Genius)

Часть [SF-DOC-04](../../ROADMAP.md). Статус: **реализовано** (`libs/six-feat-auth-lib/src/oauth_handler.cpp`).
Обоснование разбиения "выдача сессии в six-feat-auth / проверка сессии
локально в six-feat" — [ADR-0004](../../adr/0004-auth-service-local-session-verification.md).
Топология сервисов — [../c4-container.md](../c4-container.md).

## Диаграмма

```mermaid
sequenceDiagram
    autonumber
    actor Browser
    participant nginx
    participant Auth as six-feat-auth<br/>(LoginHandler/CallbackHandler)
    participant Genius as Genius API
    participant SixFeat as six-feat<br/>(RequireSession)

    Browser->>nginx: GET /auth/login
    nginx->>Auth: proxy_pass /auth/login
    Auth->>Auth: state = random(16 bytes)<br/>[+ PKCE: verifier/challenge, если pkce-enabled]
    Auth-->>Browser: Set-Cookie six_feat_oauth_state<br/>(+ six_feat_pkce_verifier)
    Auth-->>Browser: 302 → genius.com/oauth/authorize?client_id&redirect_uri&state&(code_challenge)

    Browser->>Genius: GET /oauth/authorize (пользователь логинится/подтверждает)
    Genius-->>Browser: 302 → GENIUS_REDIRECT_URI (nginx origin)/auth/callback?code&state

    Browser->>nginx: GET /auth/callback?code&state
    nginx->>Auth: proxy_pass /auth/callback
    Auth->>Auth: constant-time compare state_param vs six_feat_oauth_state cookie<br/>(CSRF-защита)

    alt state не совпал / отсутствует
        Auth-->>Browser: 400 Invalid state parameter
    else error= в query (пользователь отказал)
        Auth-->>Browser: 302 → /?auth=denied
    else code присутствует и state валиден
        Auth->>Genius: POST /oauth/token<br/>(code, client_id, client_secret, redirect_uri, [code_verifier])<br/>НАПРЯМУЮ, в обход six-feat-genius-gateway
        alt обмен успешен
            Genius-->>Auth: access_token + genius_name
            Auth->>Auth: cookie_value = Encrypt(access_token, exp, APP_SECRET, genius_name)
            Auth-->>Browser: Set-Cookie six_feat_session (HttpOnly, Secure*, SameSite=Lax)<br/>Set-Cookie six_feat_csrf (SameSite=Strict)<br/>Clear six_feat_oauth_state/six_feat_pkce_verifier
            Auth-->>Browser: 302 → /
        else обмен упал
            Auth-->>Browser: 302 → /?auth=error
        end
    end

    Note over Browser,SixFeat: Дальше — любой запрос к данным (не только сразу после логина)
    Browser->>nginx: GET /api/v1/graph?... (Cookie: six_feat_session)
    nginx->>SixFeat: proxy_pass /api/v1/graph
    SixFeat->>SixFeat: RequireSession: расшифровать cookie ЛОКАЛЬНО тем же APP_SECRET<br/>(без сетевого вызова в six-feat-auth)
    SixFeat-->>Browser: 200 граф / 401 token_invalid
```

## Что важно не потерять при чтении

- **Обмен `code`→`access_token` идёт напрямую в Genius**, минуя
  `six-feat-genius-gateway` — это одноразовый вызов на логин, а не
  FG/BG-трафик, которым занят gateway (см. `docs/DEVELOPMENT.md`,
  раздел про `six-feat-auth`).
- **`six-feat` никогда не делает сетевой вызов в `six-feat-auth`**, чтобы
  проверить сессию — `RequireSession` расшифровывает cookie тем же
  `APP_SECRET`, который использовал `six-feat-auth`. Оба сервиса обязаны
  быть подняты с одинаковым `APP_SECRET`/`GENIUS_CLIENT_ID`/
  `GENIUS_CLIENT_SECRET` (последние два `six-feat` больше не использует
  для реального обмена, но валидирует при старте).
- `Secure*` на `six_feat_session`/`six_feat_csrf` — только если
  `COOKIE_SECURE=true` (см. `docs/DEVELOPMENT.md`, раздел «Env-профили:
  dev/staging/prod», SF-CFG-01: `prod`/`staging` профили включают его по
  умолчанию, `dev` — нет, локальный HTTP).
