#!/usr/bin/env bash
# BACKUP_S3_URL + AWS_* — опциональная загрузка дампа в S3-совместимое хранилище
set -euo pipefail

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
: "${DB_NAME:?set DB_NAME}"
: "${DB_USER:?set DB_USER}"
export PGPASSWORD="${DB_PASSWORD:-}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
BACKUP_S3_URL="${BACKUP_S3_URL:-}"
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"

log()  { printf '[backup %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }

case "$BACKUP_KEEP" in
  ''|*[!0-9]*) fail "BACKUP_KEEP must be a non-negative integer, got '$BACKUP_KEEP'" ;;
esac
[ "$BACKUP_KEEP" -ge 1 ] || fail "BACKUP_KEEP must be >= 1 (refusing to delete every backup)"

command -v pg_dump    >/dev/null || fail "pg_dump not found — install a postgresql-client matching the server major version"
command -v pg_restore >/dev/null || fail "pg_restore not found (needed to verify the dump)"

client_major="$(pg_dump --version | sed -E 's/.* ([0-9]+).*/\1/')"
server_major="$(
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
       -tAc 'SHOW server_version;' 2>/dev/null | sed -E 's/^([0-9]+).*/\1/'
)" || fail "cannot reach $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
[ -n "$server_major" ] || fail "cannot reach $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"

if [ "$client_major" -lt "$server_major" ]; then
  fail "pg_dump is $client_major but the server is $server_major — pg_dump refuses to dump a newer server. Install postgresql-client-$server_major."
fi

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="six-feat-${DB_NAME}-${stamp}.dump"
dest="${BACKUP_DIR}/${base}"

while [ -e "$dest" ]; do
  sleep 1
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  base="six-feat-${DB_NAME}-${stamp}.dump"
  dest="${BACKUP_DIR}/${base}"
done

tmp="${dest}.partial"

cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

log "dumping ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} (client $client_major, server $server_major)"
pg_dump \
  --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="$tmp"

pg_restore --list "$tmp" >/dev/null 2>&1 \
  || fail "dump failed verification (pg_restore --list could not read it)"

mv "$tmp" "$dest"
trap - EXIT

if command -v sha256sum >/dev/null; then
  ( cd "$BACKUP_DIR" && sha256sum "$base" >"${base}.sha256" )
fi

size="$(du -h "$dest" | cut -f1)"
log "wrote $dest ($size)"

if [ -n "$BACKUP_S3_URL" ]; then
  if ! command -v aws >/dev/null; then
    fail "BACKUP_S3_URL is set but the 'aws' CLI is not installed"
  fi
  s3_args=(--only-show-errors)
  [ -n "$BACKUP_S3_ENDPOINT" ] && s3_args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  log "uploading to ${BACKUP_S3_URL%/}/${base}"
  aws "${s3_args[@]}" s3 cp "$dest" "${BACKUP_S3_URL%/}/${base}"
  [ -f "${dest}.sha256" ] && aws "${s3_args[@]}" s3 cp "${dest}.sha256" "${BACKUP_S3_URL%/}/${base}.sha256"
  log "upload complete"
fi

log "rotation: keeping the newest $BACKUP_KEEP of six-feat-${DB_NAME}-*.dump"
mapfile -t all_dumps < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "six-feat-${DB_NAME}-*.dump" -print | sort
)
total="${#all_dumps[@]}"
if [ "$total" -gt "$BACKUP_KEEP" ]; then
  prune_count=$((total - BACKUP_KEEP))
  for old in "${all_dumps[@]:0:$prune_count}"; do
    log "pruning $(basename "$old")"
    rm -f "$old" "${old}.sha256"
  done
  log "rotation: pruned $prune_count, $BACKUP_KEEP retained"
else
  log "rotation: $total present, nothing to prune"
fi

log "done"
