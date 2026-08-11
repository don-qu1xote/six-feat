from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import DB_CONN_PARAMS
from test_backup_restore import (
    _SKIP,
    REPO_ROOT,
    SCHEMA_SQL,
    _connect,
    _create_db,
    _drop_db,
    _run,
    _script_env,
)

DRILL = REPO_ROOT / "scripts" / "dr-drill.py"
BACKUP_SCRIPT = REPO_ROOT / "scripts" / "backup-postgres.sh"

SOURCE_DB = "six_feat_dr_src"
EMPTY_DB = "six_feat_dr_empty"
TARGET_DB = "six_feat_dr_target"

pytestmark = [
    pytest.mark.backup_restore,
    pytest.mark.skipif(_SKIP is not None, reason=_SKIP or ""),
]


def _drill(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.update(
        DB_HOST=str(DB_CONN_PARAMS["host"]),
        DB_PORT=str(DB_CONN_PARAMS["port"]),
        DB_USER=str(DB_CONN_PARAMS["user"]),
        DB_PASSWORD=str(DB_CONN_PARAMS["password"]),
    )
    return subprocess.run(
        ["python3", str(DRILL), "--target-db", TARGET_DB, *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
        cwd=str(REPO_ROOT),
    )


def _seed(dbname: str, rows: int) -> None:
    _drop_db(dbname)
    _create_db(dbname)
    conn = _connect(dbname)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(SCHEMA_SQL.read_text())
            if rows:
                cur.execute(
                    "INSERT INTO artists SELECT g, 'Artist ' || g, NULL, NULL "
                    "FROM generate_series(1, %s) g",
                    (rows,),
                )
                cur.execute(
                    "INSERT INTO songs SELECT g, 'Song ' || g FROM generate_series(1, %s) g",
                    (rows,),
                )
                cur.execute(
                    "INSERT INTO credits SELECT g, ((g * 7) %% %s) + 1, g %% 3 "
                    "FROM generate_series(1, %s) g",
                    (rows, rows),
                )
    finally:
        conn.close()


@pytest.fixture(scope="module")
def baseline(tmp_path_factory) -> Path:
    _seed(SOURCE_DB, rows=25)
    out = tmp_path_factory.mktemp("baseline")
    res = _run(BACKUP_SCRIPT, [], _script_env(SOURCE_DB, BACKUP_DIR=str(out)))
    assert res.returncode == 0, f"backup failed:\n{res.stdout}\n{res.stderr}"
    yield out
    _drop_db(SOURCE_DB)
    _drop_db(TARGET_DB)


class TestDrillPasses:
    def test_passes_on_baseline_backup(self, baseline: Path):
        res = _drill("--backup-dir", str(baseline))
        assert res.returncode == 0, f"drill failed:\n{res.stdout}\n{res.stderr}"

        report = json.loads(res.stdout[res.stdout.index("{") :])
        assert report["passed"] is True
        assert report["error"] is None
        assert report["checks"]["row_counts"]["artists"] == 25
        assert report["checks"]["orphans"] == 0
        assert report["checks"]["graph_join_rows"] > 0

    def test_writes_json_report(self, baseline: Path, tmp_path: Path):
        out = tmp_path / "report.json"
        res = _drill("--backup-dir", str(baseline), "--report", str(out))
        assert res.returncode == 0
        assert json.loads(out.read_text())["passed"] is True

    def test_drops_the_scratch_db_afterwards(self, baseline: Path):
        assert _drill("--backup-dir", str(baseline)).returncode == 0
        conn = _connect("postgres")
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (TARGET_DB,))
                assert cur.fetchone() is None
        finally:
            conn.close()


class TestDrillFailsOnBadData:
    def test_fails_on_corrupt_archive(self, baseline: Path, tmp_path: Path):
        dump = sorted(baseline.glob("six-feat-*.dump"))[0]
        broken = tmp_path / "six-feat-corrupt.dump"
        broken.write_bytes(dump.read_bytes()[:2000])

        res = _drill("--backup-dir", str(tmp_path))
        assert res.returncode == 1
        assert "не удался" in res.stdout or "упал" in res.stdout

    def test_fails_when_tables_are_missing(self, tmp_path: Path):
        out = tmp_path / "six-feat-partial.dump"
        env = _script_env(SOURCE_DB)
        dumped = subprocess.run(
            [
                "pg_dump",
                "-h",
                str(DB_CONN_PARAMS["host"]),
                "-p",
                str(DB_CONN_PARAMS["port"]),
                "-U",
                str(DB_CONN_PARAMS["user"]),
                "-d",
                SOURCE_DB,
                "-Fc",
                "-t",
                "artists",
                "-f",
                str(out),
            ],
            env={**env, "PGPASSWORD": str(DB_CONN_PARAMS["password"])},
            capture_output=True,
            text=True,
        )
        assert dumped.returncode == 0, dumped.stderr

        res = _drill("--backup-dir", str(tmp_path))
        assert res.returncode == 1
        assert "отсутствуют таблицы" in res.stdout

    def test_fails_on_empty_database_dump(self, tmp_path: Path):
        _seed(EMPTY_DB, rows=0)
        try:
            res = _run(BACKUP_SCRIPT, [], _script_env(EMPTY_DB, BACKUP_DIR=str(tmp_path)))
            assert res.returncode == 0

            drill = _drill("--backup-dir", str(tmp_path))
            assert drill.returncode == 1
            assert "неполные" in drill.stdout
        finally:
            _drop_db(EMPTY_DB)

    def test_fails_when_no_dump_exists(self, tmp_path: Path):
        res = _drill("--backup-dir", str(tmp_path))
        assert res.returncode == 1
        assert "нет ни одного" in res.stdout
