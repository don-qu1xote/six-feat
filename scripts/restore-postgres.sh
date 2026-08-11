#!/usr/bin/env bash
# pg_restore из дампа backup-postgres.sh; без --yes-i-am-sure ничего не делает, --help выводит usage.
set -euo pipefail

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
export PGPASSWORD="${DB_PASSWORD:-}"

log()  { printf '[restore %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { printf '[restore] ERROR: %s\n' "$*" >&2; exit 1; }

DUMP_FILE=""
TARGET_DB="${DB_NAME:-}"
CONFIRMED=0
CREATE_DB=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes-i-am-sure) CONFIRMED=1; shift ;;
    --create)        CREATE_DB=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --target-db)     TARGET_DB="${2:?--target-db needs a value}"; shift 2 ;;
    --target-db=*)   TARGET_DB="${1#*=}"; shift ;;
    -h|--help)       sed -n '2,28p' "$0"; exit 0 ;;
    -*)              fail "unknown option: $1" ;;
    *)
      [ -z "$DUMP_FILE" ] || fail "unexpected extra argument: $1"
      DUMP_FILE="$1"; shift ;;
  esac
done

: "${DB_USER:?set DB_USER}"

[ -n "$DUMP_FILE" ] || fail "no dump file given. Usage: $0 <dump-file> --yes-i-am-sure"
[ -f "$DUMP_FILE" ] || fail "no such file: $DUMP_FILE"
[ -n "$TARGET_DB" ] || fail "no target database — set DB_NAME or pass --target-db"

command -v pg_restore >/dev/null || fail "pg_restore not found — install a matching postgresql-client"
command -v psql       >/dev/null || fail "psql not found"

pg_restore --list "$DUMP_FILE" >/dev/null 2>&1 \
  || fail "$DUMP_FILE is not a readable pg_dump custom-format archive"

if [ -f "${DUMP_FILE}.sha256" ] && command -v sha256sum >/dev/null; then
  ( cd "$(dirname "$DUMP_FILE")" && sha256sum -c --status "$(basename "$DUMP_FILE").sha256" ) \
    || fail "checksum mismatch — $DUMP_FILE is corrupt or was modified after backup"
  log "checksum OK"
else
  log "no .sha256 alongside the dump — skipping checksum verification"
fi

table_count="$(pg_restore --list "$DUMP_FILE" | grep -c ' TABLE DATA ' || true)"
log "archive verified: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1), $table_count tables with data)"

server_reachable() {
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1
}
server_reachable || fail "cannot reach ${DB_USER}@${DB_HOST}:${DB_PORT}"

db_exists() {
  [ "$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '$1'" 2>/dev/null)" = "1" ]
}

exists=0
if db_exists "$TARGET_DB"; then exists=1; fi

echo
echo "  ────────────────────────────────────────────────────────────"
echo "  RESTORE PLAN"
echo "    source dump : $DUMP_FILE"
echo "    target      : ${DB_USER}@${DB_HOST}:${DB_PORT}/${TARGET_DB}"
if [ "$exists" -eq 1 ]; then
  live_rows="$(
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$TARGET_DB" -tAc \
      "SELECT COALESCE(sum(n_live_tup), 0) FROM pg_stat_user_tables" 2>/dev/null || echo '?'
  )"
  echo "    state       : EXISTS — approximately $live_rows live rows WILL BE OVERWRITTEN"
else
  echo "    state       : does not exist yet"
  [ "$CREATE_DB" -eq 1 ] || echo "    NOTE        : pass --create to create it"
fi
echo "  ────────────────────────────────────────────────────────────"
echo

if [ "$DRY_RUN" -eq 1 ]; then
  log "--dry-run: nothing was modified"
  exit 0
fi

if [ "$CONFIRMED" -ne 1 ]; then
  fail "refusing to restore without --yes-i-am-sure (this overwrites ${TARGET_DB})"
fi

if [ "$exists" -eq 0 ]; then
  [ "$CREATE_DB" -eq 1 ] || fail "database '$TARGET_DB' does not exist — pass --create"
  log "creating database $TARGET_DB"
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -q \
    -c "CREATE DATABASE \"$TARGET_DB\""
elif [ "$CREATE_DB" -eq 1 ]; then
  fail "--create was given but '$TARGET_DB' already exists (refusing to guess whether to drop it)"
fi

log "restoring into $TARGET_DB"
if [ "$exists" -eq 1 ]; then
  clean_args=(--clean --if-exists)
else
  clean_args=()
fi

pg_restore \
  --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$TARGET_DB" \
  --no-owner --no-privileges --exit-on-error \
  "${clean_args[@]}" \
  "$DUMP_FILE"

restored_rows="$(
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$TARGET_DB" -tAc \
    "SELECT COALESCE(sum(n_live_tup), 0) FROM pg_stat_user_tables" 2>/dev/null || echo '?'
)"
log "restore complete — ${TARGET_DB} now reports approximately ${restored_rows} live rows"
log "NOTE: verify the application against this database before pointing traffic at it"
