from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import psycopg2
import pytest

from conftest import DB_CONN_PARAMS

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKUP_SCRIPT = REPO_ROOT / "scripts" / "backup-postgres.sh"
RESTORE_SCRIPT = REPO_ROOT / "scripts" / "restore-postgres.sh"
SCHEMA_SQL = REPO_ROOT / "postgresql" / "schema.sql"

SOURCE_DB = "six_feat_bk_src"
TARGET_DB = "six_feat_bk_dst"

DATA_TABLES = ("artists", "songs", "credits", "fetch_state")


def _client_major(tool: str) -> int | None:
    exe = shutil.which(tool)
    if not exe:
        return None
    out = subprocess.run([exe, "--version"], capture_output=True, text=True).stdout
    m = re.search(r"(\d+)", out)
    return int(m.group(1)) if m else None


def _skip_reason() -> str | None:
    for tool in ("pg_dump", "pg_restore", "psql"):
        if shutil.which(tool) is None:
            return f"{tool} not installed (needs postgresql-client)"

    try:
        conn = psycopg2.connect(**{**DB_CONN_PARAMS, "dbname": "postgres"})
    except psycopg2.Error as exc:
        return f"cannot reach Postgres for backup tests: {exc}".replace("\n", " ")
    try:
        with conn.cursor() as cur:
            cur.execute("SHOW server_version")
            server_major = int(re.match(r"(\d+)", cur.fetchone()[0]).group(1))
    finally:
        conn.close()

    client_major = _client_major("pg_dump")
    if client_major is None:
        return "could not determine pg_dump version"
    if client_major < server_major:
        return (
            f"pg_dump is {client_major} but the server is {server_major}; "
            f"pg_dump refuses to dump a newer server (install postgresql-client-{server_major})"
        )
    return None


_SKIP = _skip_reason()

pytestmark = [
    pytest.mark.backup_restore,
    pytest.mark.skipif(_SKIP is not None, reason=_SKIP or ""),
]


def _maintenance_conn():
    conn = psycopg2.connect(**{**DB_CONN_PARAMS, "dbname": "postgres"})
    conn.autocommit = True
    return conn


def _drop_db(name: str) -> None:
    conn = _maintenance_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (name,),
            )
            cur.execute(f'DROP DATABASE IF EXISTS "{name}"')
    finally:
        conn.close()


def _create_db(name: str) -> None:
    conn = _maintenance_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{name}"')
    finally:
        conn.close()


def _db_exists(name: str) -> bool:
    conn = _maintenance_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,))
            return cur.fetchone() is not None
    finally:
        conn.close()


def _connect(dbname: str):
    return psycopg2.connect(**{**DB_CONN_PARAMS, "dbname": dbname})


def _script_env(dbname: str, **extra: str) -> dict:
    env = dict(os.environ)
    env.update(
        DB_HOST=str(DB_CONN_PARAMS["host"]),
        DB_PORT=str(DB_CONN_PARAMS["port"]),
        DB_USER=str(DB_CONN_PARAMS["user"]),
        DB_PASSWORD=str(DB_CONN_PARAMS["password"]),
        DB_NAME=dbname,
    )
    env.update(extra)
    return env


def _run(script: Path, args: list[str], env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(script), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        cwd=str(REPO_ROOT),
    )


def _dump_files(directory: Path) -> list[Path]:
    return sorted(directory.glob("six-feat-*.dump"))


def _read_all(dbname: str) -> dict[str, list[tuple]]:
    out: dict[str, list[tuple]] = {}
    conn = _connect(dbname)
    try:
        with conn.cursor() as cur:
            for table in DATA_TABLES:
                cur.execute(f"SELECT * FROM {table} ORDER BY 1, 2")  # noqa: S608
                out[table] = cur.fetchall()
    finally:
        conn.close()
    return out


SEED_ARTISTS = [
    (1, "Drake", "https://img.example/1.jpg", "https://genius.com/artists/1"),
    (2, "Ólafur Arnalds", None, None),
    (3, 'O\'Brien "Quote" Test', "https://img.example/3.jpg", None),
    (9_007_199_254_740_993, "Big Id", None, None),
]
SEED_SONGS = [(10, "Life Is Good"), (11, "Случайное название")]
SEED_CREDITS = [(10, 1, 0), (10, 2, 1), (11, 3, 0)]
SEED_FETCH_STATE = [(1, 2, 50, 1_700_000_000), (2, 1, 3, 1_700_000_500)]


@pytest.fixture(scope="module")
def source_db() -> str:
    _drop_db(SOURCE_DB)
    _create_db(SOURCE_DB)

    conn = _connect(SOURCE_DB)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(SCHEMA_SQL.read_text())
            cur.executemany("INSERT INTO artists VALUES (%s, %s, %s, %s)", SEED_ARTISTS)
            cur.executemany("INSERT INTO songs VALUES (%s, %s)", SEED_SONGS)
            cur.executemany("INSERT INTO credits VALUES (%s, %s, %s)", SEED_CREDITS)
            cur.executemany("INSERT INTO fetch_state VALUES (%s, %s, %s, %s)", SEED_FETCH_STATE)
    finally:
        conn.close()

    yield SOURCE_DB
    _drop_db(SOURCE_DB)


@pytest.fixture()
def clean_target_db():
    _drop_db(TARGET_DB)
    yield TARGET_DB
    _drop_db(TARGET_DB)


class TestBackupCreatesFile:
    def test_backup_writes_a_verifiable_dump_and_checksum(self, source_db: str, tmp_path: Path):
        res = _run(BACKUP_SCRIPT, [], _script_env(source_db, BACKUP_DIR=str(tmp_path)))
        assert res.returncode == 0, f"backup failed:\n{res.stdout}\n{res.stderr}"

        dumps = _dump_files(tmp_path)
        assert len(dumps) == 1, f"expected exactly one dump, got {[d.name for d in dumps]}"
        dump = dumps[0]
        assert dump.stat().st_size > 0

        listing = subprocess.run(
            ["pg_restore", "--list", str(dump)], capture_output=True, text=True
        )
        assert listing.returncode == 0, f"dump is not readable:\n{listing.stderr}"
        for table in DATA_TABLES:
            assert table in listing.stdout, f"{table} missing from the archive TOC"

        checksum = Path(str(dump) + ".sha256")
        assert checksum.is_file(), "no .sha256 written next to the dump"
        verify = subprocess.run(
            ["sha256sum", "-c", "--status", checksum.name],
            cwd=str(tmp_path),
            capture_output=True,
            text=True,
        )
        assert verify.returncode == 0, "checksum does not match the dump"

    def test_partial_file_is_not_left_behind(self, source_db: str, tmp_path: Path):
        res = _run(BACKUP_SCRIPT, [], _script_env(source_db, BACKUP_DIR=str(tmp_path)))
        assert res.returncode == 0
        assert list(tmp_path.glob("*.partial")) == []


class TestRestoreRoundTrip:
    def test_restore_into_clean_db_reproduces_every_row(
        self, source_db: str, clean_target_db: str, tmp_path: Path
    ):
        backup = _run(BACKUP_SCRIPT, [], _script_env(source_db, BACKUP_DIR=str(tmp_path)))
        assert backup.returncode == 0, f"{backup.stdout}\n{backup.stderr}"
        dump = _dump_files(tmp_path)[0]

        restore = _run(
            RESTORE_SCRIPT,
            [str(dump), "--target-db", clean_target_db, "--create", "--yes-i-am-sure"],
            _script_env(source_db),
        )
        assert restore.returncode == 0, f"restore failed:\n{restore.stdout}\n{restore.stderr}"

        expected = _read_all(source_db)
        actual = _read_all(clean_target_db)
        assert actual == expected

        assert sum(len(rows) for rows in expected.values()) == (
            len(SEED_ARTISTS) + len(SEED_SONGS) + len(SEED_CREDITS) + len(SEED_FETCH_STATE)
        )

    def test_restore_over_populated_db_replaces_rather_than_merges(
        self, source_db: str, clean_target_db: str, tmp_path: Path
    ):
        backup = _run(BACKUP_SCRIPT, [], _script_env(source_db, BACKUP_DIR=str(tmp_path)))
        assert backup.returncode == 0
        dump = _dump_files(tmp_path)[0]

        _create_db(clean_target_db)
        conn = _connect(clean_target_db)
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(SCHEMA_SQL.read_text())
                cur.execute("INSERT INTO artists VALUES (4242, 'Should Not Survive', NULL, NULL)")
        finally:
            conn.close()

        restore = _run(
            RESTORE_SCRIPT,
            [str(dump), "--target-db", clean_target_db, "--yes-i-am-sure"],
            _script_env(source_db),
        )
        assert restore.returncode == 0, f"{restore.stdout}\n{restore.stderr}"

        assert _read_all(clean_target_db) == _read_all(source_db)
        ids = [row[0] for row in _read_all(clean_target_db)["artists"]]
        assert 4242 not in ids, "stale row survived the restore"


class TestRotation:
    def test_never_keeps_more_than_backup_keep(self, source_db: str, tmp_path: Path):
        keep = 2
        runs = 5
        for i in range(runs):
            res = _run(
                BACKUP_SCRIPT,
                [],
                _script_env(source_db, BACKUP_DIR=str(tmp_path), BACKUP_KEEP=str(keep)),
            )
            assert res.returncode == 0, f"run {i} failed:\n{res.stdout}\n{res.stderr}"

        dumps = _dump_files(tmp_path)
        assert len(dumps) == keep, f"expected {keep} dumps, got {[d.name for d in dumps]}"

        assert [d.name for d in dumps] == sorted(d.name for d in dumps)

        checksums = sorted(tmp_path.glob("*.sha256"))
        assert len(checksums) == keep
        assert {c.name for c in checksums} == {d.name + ".sha256" for d in dumps}

    def test_rejects_a_keep_value_that_would_delete_everything(
        self, source_db: str, tmp_path: Path
    ):
        res = _run(
            BACKUP_SCRIPT,
            [],
            _script_env(source_db, BACKUP_DIR=str(tmp_path), BACKUP_KEEP="0"),
        )
        assert res.returncode != 0
        assert "BACKUP_KEEP" in res.stderr


class TestRestoreRequiresConfirmation:
    def test_refuses_without_the_flag_and_creates_nothing(
        self, source_db: str, clean_target_db: str, tmp_path: Path
    ):
        backup = _run(BACKUP_SCRIPT, [], _script_env(source_db, BACKUP_DIR=str(tmp_path)))
        assert backup.returncode == 0
        dump = _dump_files(tmp_path)[0]

        res = _run(
            RESTORE_SCRIPT,
            [str(dump), "--target-db", clean_target_db, "--create"],
            _script_env(source_db),
        )
        assert res.returncode != 0
        assert "--yes-i-am-sure" in res.stderr
        assert not _db_exists(clean_target_db), "refused restore still created the database"

    def test_dry_run_changes_nothing(self, source_db: str, clean_target_db: str, tmp_path: Path):
        backup = _run(BACKUP_SCRIPT, [], _script_env(source_db, BACKUP_DIR=str(tmp_path)))
        assert backup.returncode == 0
        dump = _dump_files(tmp_path)[0]

        res = _run(
            RESTORE_SCRIPT,
            [str(dump), "--target-db", clean_target_db, "--create", "--dry-run"],
            _script_env(source_db),
        )
        assert res.returncode == 0
        assert not _db_exists(clean_target_db)

    def test_rejects_a_corrupt_archive_before_touching_the_target(
        self, source_db: str, clean_target_db: str, tmp_path: Path
    ):
        bogus = tmp_path / "six-feat-bogus.dump"
        bogus.write_bytes(b"this is not a pg_dump archive")

        res = _run(
            RESTORE_SCRIPT,
            [str(bogus), "--target-db", clean_target_db, "--create", "--yes-i-am-sure"],
            _script_env(source_db),
        )
        assert res.returncode != 0
        assert not _db_exists(clean_target_db)
