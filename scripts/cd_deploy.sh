#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/cd_deploy.sh — SF-CI-07 этап 3/7: деплой одного окружения из образов,
# уже запушенных пайплайном в registry.
#
# ОДИН И ТОТ ЖЕ скрипт деплоит staging и production — разница только в
# значениях DEPLOY_ENV/ENV_PROFILE/DEPLOY_HOST, что и есть "один шаблон,
# разные профили", как требует тикет. Это же скрипт перезапускает rollback,
# только с более старым IMAGE_TAG.
#
# Зачем оверрайд-файл вместо `docker compose up` прямо из docker-compose.yml:
# каждый сервис в docker-compose.yml содержит `build:` + `pull_policy: build` +
# `image: <name>:latest`, то есть compose СОБИРАЕТ из исходников на хосте и
# игнорирует registry. Чтобы деплоить артефакт, который CI собрал и подписал,
# нужны привязки к immutable-образу ghcr.io/<owner>/<svc>:<sha> — это и делает
# генерируемый оверрайд. Поэтому удалённый `up` запускается с `--no-build`
# (сборка на хосте деплоя породила бы другие бинарники, не прошедшие пайплайн).
#
# Замечание (честная зависимость): тикет указывает ENV_PROFILE=staging /=production
# согласно SF-CFG-01/02. Этой переменной в репозитории пока нет — docker-compose.yml
# сейчас различает окружения только через .env и compose-профили (`profiles:`),
# что другой механизм. ENV_PROFILE экспортируется в compose-вызов здесь, так что
# контракт деплоя будет корректен, когда SF-CFG-01/02 появится; пока это просто
# непрочитанная переменная, и все окружения получают одну топологию compose.
# Это gap конфигурационного паритета, а не пайплайна.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Обязательные входные переменные ─────────────────────────────────────────
: "${DEPLOY_ENV:?установи DEPLOY_ENV (staging|production)}"
: "${ENV_PROFILE:?установи ENV_PROFILE (имя профиля SF-CFG-01/02)}"
: "${IMAGE_REGISTRY:?установи IMAGE_REGISTRY (напр. ghcr.io)}"
: "${IMAGE_OWNER:?установи IMAGE_OWNER (GitHub org/user, владелец пакетов)}"
: "${IMAGE_TAG:?установи IMAGE_TAG (git sha релиза)}"

# DRY_RUN=1 рендерит + валидирует локально и печатает удалённые команды
# вместо их выполнения. Никаких сетевых вызовов, ssh или хостов.
DRY_RUN="${DRY_RUN:-0}"

# Заглушки — владелец подставит реальные адреса. НАМЕРЕННО не имеют
# умолчаний, ведущих куда-то достижимое: неправильно настроенный пайплайн
# должен падать громко, а не деплоить не туда.
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/six-feat}"

# Compose-стек осмыслен только с настоящим .env на хосте деплоя
# (GENIUS_CLIENT_ID/APP_SECRET/DB_PASSWORD/... требуются через `${VAR:?}`).
# Этот файл живёт на хосте и никогда не рендерится здесь — пайплайн не видит
# этих секретов. Для локальной валидации берём .env.example, в котором есть
# значение-заполнитель для каждой обязательной переменной.
ENV_FILE_FOR_VALIDATION="${ENV_FILE_FOR_VALIDATION:-.env.example}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OVERRIDE_FILE="docker-compose.images.yml"

# Имя сервиса в docker-compose.yml → имя образа, который пушит пайплайн.
# Идентично publish-матрице в ci.yml (six-feat публикуется как "six-feat",
# не "six-feat-six-feat") — синхронизируйте их.
SERVICES=(
  "six-feat:six-feat"
  "six-feat-enrichment:six-feat-enrichment"
  "six-feat-auth:six-feat-auth"
  "six-feat-genius-gateway:six-feat-genius-gateway"
  "six-feat-game:six-feat-game"
)

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# ── 1. Рендер оверрайда с привязкой образов ─────────────────────────────────
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
    # `build` остаётся объявленным в базовом файле; pull_policy: missing
    # не даёт compose пересобрать, а явные `pull` + `--no-build` ниже
    # делают эту гарантию абсолютной, а не зависящей от политики.
    echo "    pull_policy: missing"
  done
} >"$OVERRIDE_FILE"

cat "$OVERRIDE_FILE"

COMPOSE_FILES=(-f docker-compose.yml -f "$OVERRIDE_FILE")

# ── 2. Валидация собранного стека ───────────────────────────────────────────
# Выполняется в ОБОИХ режимах: оверрайд, который не мержится чисто, должен
# упасть здесь, до отправки на хост, а не посередине удалённого `up`.
log "Валидация сконфигурированного compose"
docker compose "${COMPOSE_FILES[@]}" --env-file "$ENV_FILE_FOR_VALIDATION" config -q
log "Конфигурация compose валидна"

# ── 3. Применение ───────────────────────────────────────────────────────────
# Единственный источник последовательности команд, чтобы dry-run печатал
# байт-в-байт то же, что выполнит настоящий деплой.
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
