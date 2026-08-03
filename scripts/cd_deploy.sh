#!/usr/bin/env bash
set -euo pipefail

: "${DEPLOY_ENV:?установи DEPLOY_ENV (staging|production)}"
: "${ENV_PROFILE:?установи ENV_PROFILE (имя профиля SF-CFG-01/02)}"
: "${IMAGE_REGISTRY:?установи IMAGE_REGISTRY (напр. ghcr.io)}"
: "${IMAGE_OWNER:?установи IMAGE_OWNER (GitHub org/user, владелец пакетов)}"
: "${IMAGE_TAG:?установи IMAGE_TAG (git sha релиза)}"

# DRY_RUN=1 — рендер + валидация и печать команд, без ssh и хостов
DRY_RUN="${DRY_RUN:-0}"

# Заглушки без умолчаний: неправильно настроенный пайплайн должен падать громко
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/six-feat}"

# Локальная валидация идёт по .env.example — в нём есть заполнитель на каждую обязательную переменную
ENV_FILE_FOR_VALIDATION="${ENV_FILE_FOR_VALIDATION:-.env.example}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OVERRIDE_FILE="docker-compose.images.yml"

# Имена сервисов — как в publish-матрице ci.yml, синхронизируйте их
SERVICES=(
  "six-feat:six-feat"
  "six-feat-enrichment:six-feat-enrichment"
  "six-feat-auth:six-feat-auth"
  "six-feat-genius-gateway:six-feat-genius-gateway"
  "six-feat-game:six-feat-game"
)

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

log "Рендер $OVERRIDE_FILE для env=$DEPLOY_ENV profile=$ENV_PROFILE tag=$IMAGE_TAG"
{
  echo "# СГЕНЕРИРОВАНО scripts/cd_deploy.sh — не коммитить, не редактировать."
  echo "# Привязывает каждый сервис к immutable-образу, собранному в этом запуске."
  echo "# env=$DEPLOY_ENV profile=$ENV_PROFILE tag=$IMAGE_TAG"
  echo "services:"
  for entry in "${SERVICES[@]}"; do
    svc="${entry%%:*}"
    img="${entry##*:}"
    echo "  ${svc}:"
    echo "    image: ${IMAGE_REGISTRY}/${IMAGE_OWNER}/${img}:${IMAGE_TAG}"
    # pull_policy: missing + --no-build ниже — не пересобирать из исходников на хосте деплоя
    echo "    pull_policy: missing"
  done
} >"$OVERRIDE_FILE"

cat "$OVERRIDE_FILE"

COMPOSE_FILES=(-f docker-compose.yml -f "$OVERRIDE_FILE")

log "Валидация сконфигурированного compose"
docker compose "${COMPOSE_FILES[@]}" --env-file "$ENV_FILE_FOR_VALIDATION" config -q
log "Конфигурация compose валидна"

remote_script() {
  cat <<REMOTE
set -euo pipefail
cd '${DEPLOY_PATH}'
export ENV_PROFILE='${ENV_PROFILE}'
docker compose -f docker-compose.yml -f ${OVERRIDE_FILE} pull
docker compose -f docker-compose.yml -f ${OVERRIDE_FILE} up -d --no-build --remove-orphans
docker compose -f docker-compose.yml -f ${OVERRIDE_FILE} ps
REMOTE
}

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY RUN — ни один хост не контактируется. Был бы деплой на: ${DEPLOY_HOST:-<не задан: secrets.${DEPLOY_ENV^^}_HOST>}"
  echo "--- было бы скопировано ---"
  echo "scp docker-compose.yml ${OVERRIDE_FILE} ${DEPLOY_USER}@<host>:${DEPLOY_PATH}/"
  echo "--- было бы выполнено на <host> ---"
  remote_script
  echo "------------------"
  log "DRY RUN завершён для $DEPLOY_ENV"
  exit 0
fi

if [[ -z "$DEPLOY_HOST" ]]; then
  echo "::error::DEPLOY_HOST пуст — установи secrets.${DEPLOY_ENV^^}_HOST в реальный хост (в этом репозитории это заглушка)." >&2
  exit 1
fi

log "Деплой на ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}"
scp -o StrictHostKeyChecking=accept-new \
  docker-compose.yml "$OVERRIDE_FILE" \
  "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/"
remote_script | ssh -o StrictHostKeyChecking=accept-new "${DEPLOY_USER}@${DEPLOY_HOST}" bash -s
log "Деплой на $DEPLOY_ENV завершён (tag=$IMAGE_TAG)"
