#!/usr/bin/env bash
# [SF-INF-10] Развёртывание полного стека на локальной машине — сегодня это
# единственная реальная среда: STAGING_HOST/PROD_HOST не существует, и CD до
# сих пор ходил только по «репетиционной» ветке.
#
# Стадии те же, что в .github/workflows/cd.yml, и в том же порядке:
#   preflight → up → health-check (/readyz) → smoke → (опционально) туннель.
# Health-check и smoke НЕ переписаны: вызываются те же cd_health_check.py и
# cd_smoke_test.py, что и в CD, — локальный деплой обязан падать ровно там же
# и по тем же причинам, по которым упал бы удалённый.
#
# Второго compose-файла нет и не будет (правило SF-CFG-02): отличие от `make
# dev` — только ENV_PROFILE, то есть config/profiles/<profile>.env.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${ENV_FILE:-.env}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
[ "${DEPLOY_LOCAL_DRY_RUN:-0}" = "1" ] && DRY_RUN=1

log()  { printf '[deploy-local] %s\n' "$*"; }
warn() { printf '[deploy-local] ВНИМАНИЕ: %s\n' "$*" >&2; }
die()  { printf '[deploy-local] ОШИБКА: %s\n' "$*" >&2; exit 1; }

# ── Stage 0: что и куда разворачиваем ────────────────────────────────────────

[ -f "$ENV_FILE" ] || die "нет $ENV_FILE — скопируйте .env.example и заполните
  (минимум: GENIUS_CLIENT_ID, GENIUS_CLIENT_SECRET, APP_SECRET, DB_PASSWORD,
  ENRICHMENT_INTERNAL_SECRET). См. docs/DEVELOPMENT.md «Как поднять у себя»."

env_file_value() {
  # Значение переменной из .env, без source: там могут быть секреты и кавычки,
  # исполнять файл ради одной строки незачем.
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n1 | tr -d '"'\''' | tr -d '\r'
}

PROFILE_SOURCE="дефолт скрипта"
if [ -n "${ENV_PROFILE:-}" ]; then
  PROFILE_SOURCE="переменная окружения"
elif [ -n "$(env_file_value ENV_PROFILE)" ]; then
  ENV_PROFILE="$(env_file_value ENV_PROFILE)"
  PROFILE_SOURCE="$ENV_FILE"
else
  ENV_PROFILE="staging"
fi
export ENV_PROFILE

# Смысл локального деплоя — проверить БОЕВУЮ конфигурацию (COOKIE_SECURE,
# уровни логов, лимиты), а не dev-дефолты. staging по умолчанию, а не prod:
# у prod-профиля DB_REPLICA_HOST=postgres-replica, то есть нужен ещё и
# compose-профиль prod-like с настоящей репликой — это уже не «одна команда».
if [ "$ENV_PROFILE" = "dev" ]; then
  die "ENV_PROFILE=dev ($PROFILE_SOURCE) — dev-профиль здесь запрещён: локальный
  деплой существует ровно для того, чтобы прогнать боевую конфигурацию.
  Запустите как \`ENV_PROFILE=staging make deploy-local\` или поменяйте
  ENV_PROFILE в $ENV_FILE. Нужен именно dev — это \`make dev\`."
fi

[ -f "config/profiles/${ENV_PROFILE}.env" ] ||
  die "нет config/profiles/${ENV_PROFILE}.env (ожидались staging или prod)"

if [ "$ENV_PROFILE" = "prod" ]; then
  warn "профиль prod ждёт DB_REPLICA_HOST=postgres-replica, а реплику поднимает
  отдельный compose-профиль: \`docker compose --profile prod-like up -d\`. Без неё
  userver-кластер не найдёт Slave. Для одной машины обычно нужен staging —
  та же боевая посадка куки и логов, но один инстанс Postgres."
fi

PUBLIC_PORT="$(env_file_value NGINX_PUBLIC_PORT)"
PUBLIC_PORT="${NGINX_PUBLIC_PORT:-${PUBLIC_PORT:-8080}}"
BASE_URL="${BASE_URL:-http://localhost:${PUBLIC_PORT}}"

PUBLIC_TUNNEL="${PUBLIC_TUNNEL:-off}"

log "профиль: $ENV_PROFILE ($PROFILE_SOURCE)"
log "адрес:   $BASE_URL"
log "туннель: $PUBLIC_TUNNEL"

# ── Stage 1: preflight ───────────────────────────────────────────────────────

command -v docker >/dev/null 2>&1 || die "docker не найден в PATH"

# Рендер compose проверяет ВСЕ обязательные ${VAR:?...} разом и не требует
# запущенного демона — то же, что делает cd_deploy.sh перед отправкой на хост.
log "проверяю рендер docker-compose.yml с $ENV_FILE"
docker compose --env-file "$ENV_FILE" config --quiet ||
  die "docker-compose.yml не рендерится с текущим $ENV_FILE (см. сообщение выше)"

COOKIE_SECURE_EFFECTIVE="$(env_file_value COOKIE_SECURE)"
if [ -z "$COOKIE_SECURE_EFFECTIVE" ]; then
  COOKIE_SECURE_EFFECTIVE="$(sed -n 's/.*COOKIE_SECURE="\${COOKIE_SECURE:-\([a-z]*\)}".*/\1/p' \
    "config/profiles/${ENV_PROFILE}.env")"
fi
if [ "$COOKIE_SECURE_EFFECTIVE" = "true" ] && [ "${BASE_URL#https://}" = "$BASE_URL" ]; then
  warn "профиль $ENV_PROFILE ставит COOKIE_SECURE=true, а стек открыт по http://.
  Браузер не отправит Secure-куку по http — вход через Genius на $BASE_URL
  работать НЕ будет. Это не сломанный деплой, а честное поведение боевого
  профиля: либо заходите через туннель (он даёт https), либо задайте
  COOKIE_SECURE=false в $ENV_FILE, понимая, что проверяете уже не боевую
  посадку куки."
fi

if [ "$PUBLIC_TUNNEL" != "off" ]; then
  # Туннель делает домашнюю машину доступной из интернета — в CI ему делать
  # нечего ни при каких условиях.
  [ -z "${CI:-}" ] || die "PUBLIC_TUNNEL=$PUBLIC_TUNNEL в CI — отказ. Туннель поднимают руками."
  [ "$PUBLIC_TUNNEL" = "cloudflared" ] ||
    die "PUBLIC_TUNNEL=$PUBLIC_TUNNEL не поддерживается (поддерживается: off, cloudflared)"
  command -v cloudflared >/dev/null 2>&1 ||
    die "PUBLIC_TUNNEL=cloudflared, но бинарника cloudflared нет в PATH"
fi

if [ "$DRY_RUN" = "1" ]; then
  log "--dry-run: preflight пройден, стек не поднимаю"
  exit 0
fi

# ── Stage 2: подъём стека (тот же compose, отличается только профиль) ────────

log "docker compose up -d --build"
docker compose --env-file "$ENV_FILE" up -d --build

# ── Stage 3: health-check — тот же гейт, что Stage 4 в CD ───────────────────

log "health-check: ${BASE_URL}/readyz"
python3 scripts/cd_health_check.py --base-url "$BASE_URL" --timeout "${HEALTH_TIMEOUT:-300}" ||
  die "health-check не пройден. Логи: docker compose logs --tail=100"

# ── Stage 4: smoke — тот же набор, что Stage 5 в CD ─────────────────────────

log "smoke-тесты"
python3 scripts/cd_smoke_test.py --base-url "$BASE_URL" ||
  die "smoke-тесты не пройдены. Логи: docker compose logs --tail=100"

log "стек поднят и прошёл те же гейты, что удалённый деплой: $BASE_URL"

# ── Stage 5: публичный доступ, по умолчанию выключен ────────────────────────

if [ "$PUBLIC_TUNNEL" = "off" ]; then
  log "туннель выключен (PUBLIC_TUNNEL=off) — стек доступен только с этой машины"
  exit 0
fi

warn "поднимаю публичный туннель: ЭТА МАШИНА СТАНОВИТСЯ ДОСТУПНА ИЗ ИНТЕРНЕТА.
  Наружу уезжает всё, что слушает на $BASE_URL, вместе с данными в локальной БД.
  Туннель живёт, пока запущен этот процесс — Ctrl-C закрывает доступ."
exec cloudflared tunnel --url "$BASE_URL"
