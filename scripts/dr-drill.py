#!/usr/bin/env python3
"""dr-drill.py — SF-INF-09: автоматический прогон disaster recovery.

Берёт последний дамп SF-INF-08, восстанавливает его в чистый Postgres и
проверяет восстановленные данные. Превращает docs/runbooks/disaster-recovery.md
в проверяемый факт: падает, если restore даёт битые или неполные данные.

Источник дампа: --dump | --s3-url | --backup-dir (в этом порядке).
Цель: --container (docker run postgres:16-alpine) либо существующий сервер
из DB_HOST/DB_PORT/DB_USER/DB_PASSWORD.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RESTORE_SCRIPT = REPO_ROOT / "scripts" / "restore-postgres.sh"

PG_IMAGE = "postgres:16-alpine"
DUMP_GLOB = "six-feat-*.dump"

EXPECTED_TABLES = ("artists", "songs", "credits", "fetch_state")
NONEMPTY_TABLES = ("artists", "songs", "credits")


class DrillError(Exception): ...


def log(msg: str) -> None:
    print(f"[dr-drill] {msg}", flush=True)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def resolve_dump(args: argparse.Namespace) -> Path:
    if args.dump:
        dump = Path(args.dump)
        if not dump.is_file():
            raise DrillError(f"дамп не найден: {dump}")
        return dump

    if args.s3_url:
        return fetch_latest_from_s3(args.s3_url, args.s3_endpoint, Path(args.workdir))

    backup_dir = Path(args.backup_dir)
    if not backup_dir.is_dir():
        raise DrillError(f"BACKUP_DIR не существует: {backup_dir}")
    dumps = sorted(backup_dir.glob(DUMP_GLOB))
    if not dumps:
        raise DrillError(f"в {backup_dir} нет ни одного {DUMP_GLOB}")
    return dumps[-1]


def fetch_latest_from_s3(s3_url: str, endpoint: str | None, workdir: Path) -> Path:
    if shutil.which("aws") is None:
        raise DrillError("--s3-url задан, но aws CLI не установлен")
    base = ["aws", "--only-show-errors"]
    if endpoint:
        base += ["--endpoint-url", endpoint]

    listing = run([*base, "s3", "ls", s3_url.rstrip("/") + "/"])
    if listing.returncode != 0:
        raise DrillError(f"aws s3 ls не удался: {listing.stderr.strip()}")
    keys = sorted(
        line.split()[-1]
        for line in listing.stdout.splitlines()
        if line.split() and line.split()[-1].endswith(".dump")
    )
    if not keys:
        raise DrillError(f"в {s3_url} нет ни одного .dump")

    latest = keys[-1]
    workdir.mkdir(parents=True, exist_ok=True)
    local = workdir / latest
    log(f"скачиваю {latest} из {s3_url}")
    got = run([*base, "s3", "cp", f"{s3_url.rstrip('/')}/{latest}", str(local)])
    if got.returncode != 0:
        raise DrillError(f"aws s3 cp не удался: {got.stderr.strip()}")
    run([*base, "s3", "cp", f"{s3_url.rstrip('/')}/{latest}.sha256", str(local) + ".sha256"])
    return local


def start_container(port: int, password: str) -> str:
    if shutil.which("docker") is None:
        raise DrillError("--container задан, но docker не установлен")
    name = f"sf-dr-drill-{uuid.uuid4().hex[:8]}"
    log(f"поднимаю чистый {PG_IMAGE} как {name} на порту {port}")
    started = run(
        [
            "docker",
            "run",
            "--detach",
            "--name",
            name,
            "--env",
            f"POSTGRES_PASSWORD={password}",
            "--env",
            "POSTGRES_USER=six_feat",
            "--env",
            "POSTGRES_DB=postgres",
            "--publish",
            f"127.0.0.1:{port}:5432",
            PG_IMAGE,
        ]
    )
    if started.returncode != 0:
        raise DrillError(f"docker run не удался: {started.stderr.strip()}")
    return name


def stop_container(name: str) -> None:
    log(f"убираю контейнер {name}")
    run(["docker", "rm", "--force", "--volumes", name])


def psql(conn: dict, dbname: str, sql: str) -> str:
    env = {**os.environ, "PGPASSWORD": conn["password"]}
    res = run(
        [
            "psql",
            "-h",
            conn["host"],
            "-p",
            str(conn["port"]),
            "-U",
            conn["user"],
            "-d",
            dbname,
            "-tAc",
            sql,
        ],
        env=env,
    )
    if res.returncode != 0:
        raise DrillError(f"psql не удался ({dbname}): {res.stderr.strip()}")
    return res.stdout.strip()


def wait_ready(conn: dict, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        try:
            if psql(conn, "postgres", "SELECT 1") == "1":
                return
        except DrillError as exc:
            last = str(exc)
        time.sleep(1)
    raise DrillError(f"Postgres не поднялся за {timeout:.0f}s: {last}")


def restore(conn: dict, dump: Path, target_db: str) -> None:
    env = {
        **os.environ,
        "DB_HOST": conn["host"],
        "DB_PORT": str(conn["port"]),
        "DB_USER": conn["user"],
        "DB_PASSWORD": conn["password"],
        "DB_NAME": target_db,
    }
    res = subprocess.run(
        [str(RESTORE_SCRIPT), str(dump), "--target-db", target_db, "--create", "--yes-i-am-sure"],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=1800,
    )
    if res.returncode != 0:
        raise DrillError(f"restore-postgres.sh упал:\n{res.stdout}\n{res.stderr}")


def verify(conn: dict, dbname: str, min_rows: int) -> dict:
    checks: dict[str, object] = {}

    present = set(
        psql(
            conn,
            dbname,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
        ).split()
    )
    missing = [t for t in EXPECTED_TABLES if t not in present]
    if missing:
        raise DrillError(f"после restore отсутствуют таблицы: {missing}")
    checks["tables"] = sorted(present & set(EXPECTED_TABLES))

    counts = {}
    for table in EXPECTED_TABLES:
        counts[table] = int(psql(conn, dbname, f"SELECT count(*) FROM {table}"))
    checks["row_counts"] = counts

    empty = [t for t in NONEMPTY_TABLES if counts[t] < min_rows]
    if empty:
        raise DrillError(
            f"восстановленные данные неполные: {empty} содержат меньше {min_rows} строк "
            f"(counts={counts})"
        )

    orphan_artists = int(
        psql(
            conn,
            dbname,
            "SELECT count(*) FROM credits c "
            "LEFT JOIN artists a ON a.id = c.artist_id WHERE a.id IS NULL",
        )
    )
    orphan_songs = int(
        psql(
            conn,
            dbname,
            "SELECT count(*) FROM credits c "
            "LEFT JOIN songs s ON s.id = c.song_id WHERE s.id IS NULL",
        )
    )
    if orphan_artists or orphan_songs:
        raise DrillError(
            f"нарушена ссылочная целостность: {orphan_artists} credits без artist, "
            f"{orphan_songs} без song"
        )
    checks["orphans"] = 0

    sample = int(
        psql(
            conn,
            dbname,
            "SELECT count(*) FROM credits c "
            "JOIN artists a ON a.id = c.artist_id JOIN songs s ON s.id = c.song_id",
        )
    )
    if sample < min_rows:
        raise DrillError(
            f"smoke-запрос (graph join) вернул {sample} строк, ожидалось >= {min_rows}"
        )
    checks["graph_join_rows"] = sample

    return checks


def emit(report: dict, path: str | None) -> None:
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if path:
        Path(path).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        status = "PASS" if report["passed"] else "FAIL"
        lines = [
            f"### DR drill: {status}",
            "",
            f"- дамп: `{report.get('dump')}`",
            f"- длительность: {report.get('duration_sec')} s",
        ]
        if report.get("checks"):
            lines.append(f"- строки: `{report['checks'].get('row_counts')}`")
        if report.get("error"):
            lines.append(f"- ошибка: `{report['error']}`")
        with Path(summary).open("a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--dump", help="конкретный файл дампа (обходит --s3-url/--backup-dir)")
    p.add_argument("--backup-dir", default=os.environ.get("BACKUP_DIR", "./.backups"))
    p.add_argument("--s3-url", default=os.environ.get("BACKUP_S3_URL") or None)
    p.add_argument("--s3-endpoint", default=os.environ.get("BACKUP_S3_ENDPOINT") or None)
    p.add_argument("--container", action="store_true", help="поднять чистый Postgres в docker")
    p.add_argument("--port", type=int, default=55432, help="порт для --container")
    p.add_argument("--target-db", default="six_feat_dr_drill")
    p.add_argument("--min-rows", type=int, default=1)
    p.add_argument("--timeout", type=float, default=120.0, help="ожидание готовности Postgres")
    p.add_argument("--workdir", default="/tmp/dr-drill")
    p.add_argument("--report", help="записать JSON-отчёт в файл")
    args = p.parse_args()

    started = time.monotonic()
    report: dict = {"passed": False, "dump": None, "checks": None, "error": None}
    container = None
    conn: dict | None = None

    try:
        for tool in ("psql", "pg_restore"):
            if shutil.which(tool) is None:
                raise DrillError(f"{tool} не найден — нужен postgresql-client")

        dump = resolve_dump(args)
        report["dump"] = str(dump)
        log(f"дамп: {dump} ({dump.stat().st_size} байт)")

        if args.container:
            password = uuid.uuid4().hex
            container = start_container(args.port, password)
            conn = {
                "host": "127.0.0.1",
                "port": args.port,
                "user": "six_feat",
                "password": password,
            }
        else:
            conn = {
                "host": os.environ.get("DB_HOST", "127.0.0.1"),
                "port": int(os.environ.get("DB_PORT", "5432")),
                "user": os.environ.get("DB_USER", "six_feat"),
                "password": os.environ.get("DB_PASSWORD", ""),
            }

        wait_ready(conn, args.timeout)

        psql(conn, "postgres", f'DROP DATABASE IF EXISTS "{args.target_db}"')

        log(f"restore в {args.target_db}")
        restore(conn, dump, args.target_db)

        log("проверяю восстановленные данные")
        report["checks"] = verify(conn, args.target_db, args.min_rows)
        report["passed"] = True
        log("PASS")

    except DrillError as exc:
        report["error"] = str(exc)
        print(f"::error::DR drill FAILED — {exc}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        report["error"] = f"{type(exc).__name__}: {exc}"
        print(f"::error::DR drill FAILED — {report['error']}", file=sys.stderr)
    finally:
        if container:
            stop_container(container)
        elif conn is not None:
            with contextlib.suppress(DrillError):
                psql(conn, "postgres", f'DROP DATABASE IF EXISTS "{args.target_db}"')

    report["duration_sec"] = round(time.monotonic() - started, 1)
    emit(report, args.report)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
