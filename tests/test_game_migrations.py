"""
test_game_migrations.py — [SF-GAME-11] parity between game_migrations
(services/game/game_store.cpp) and the versioned reference copies under
postgresql/migrations/game/V*.sql.

Same contract, and the same pure-text approach, as tests/test_migrations.py
(SF-DB-05): game_migrations is what actually runs against Postgres
(RunGameMigrations, applied in-process, gated by the game_schema_version
table) — the game/V*.sql files are a documentation-only mirror. This test
parses both sides and diffs them structurally (whitespace-normalized, per
statement, in order) so drift becomes a test failure instead of silent doc
rot. No C++ build, no live Postgres required.

Scenarios covered:
  1. Every game_migrations entry has a corresponding game/V{n}__*.sql file.
  2. Every game/V*.sql file has a corresponding game_migrations entry.
  3. Per migration: the .sql file's statements match the C++ array's
     statements, in order, modulo whitespace formatting.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Tuple

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
GAME_STORE_CPP = REPO_ROOT / "services" / "game" / "src" / "core" / "game_store.cpp"
MIGRATIONS_DIR = REPO_ROOT / "postgresql" / "migrations" / "game"


def _normalize(sql: str) -> str:
    """Collapse whitespace runs to a single space and drop a trailing
    semicolon, so only actual DDL differences count as a mismatch."""
    sql = sql.strip()
    if sql.endswith(";"):
        sql = sql[:-1]
    return re.sub(r"\s+", " ", sql).strip()


def _extract_cpp_array(source: str, var_name: str) -> List[str]:
    """Pull the ordered list of string-literal statements out of
    `const std::vector<const char*> {var_name} = { ... };` in game_store.cpp —
    handles both R"SQL(...)SQL" raw strings and plain "..." literals."""
    block_match = re.search(
        rf"const std::vector<const char\*>\s+{re.escape(var_name)}\s*=\s*\{{(.*?)\}};",
        source,
        re.DOTALL,
    )
    assert block_match, f"could not find {var_name} array in game_store.cpp"
    block = block_match.group(1)

    statements = []
    for m in re.finditer(r'R"SQL\((.*?)\)SQL"|"((?:[^"\\]|\\.)*)"', block, re.DOTALL):
        raw, plain = m.group(1), m.group(2)
        statements.append(raw if raw is not None else plain)
    return statements


def _extract_migrations_list(source: str) -> List[Tuple[int, str]]:
    """Parse `const std::vector<Migration> game_migrations = { {1, kGameMigrationV1}, ... };`
    into an ordered [(version, cpp_array_var_name), ...] list."""
    block_match = re.search(
        r"const std::vector<Migration>\s+kGameMigrations\s*=\s*\{(.*?)\};",
        source,
        re.DOTALL,
    )
    assert block_match, "could not find kGameMigrations array in game_store.cpp"
    block = block_match.group(1)

    pairs = re.findall(r"\{\s*(\d+)\s*,\s*(kGameMigrationV\d+)\s*\}", block)
    assert pairs, "game_migrations array is empty or unparseable"
    return [(int(version), var_name) for version, var_name in pairs]


def _extract_sql_file_statements(path: Path) -> List[str]:
    """Strip `--` line comments and split the file into individual
    semicolon-terminated statements, in order."""
    text = path.read_text()
    lines = [line.split("--", 1)[0] for line in text.splitlines()]
    text_no_comments = "\n".join(lines)
    return [s for s in text_no_comments.split(";") if s.strip()]


_CPP_SOURCE = GAME_STORE_CPP.read_text()
_MIGRATIONS = _extract_migrations_list(_CPP_SOURCE)


def test_every_migration_has_a_versioned_sql_file():
    missing = []
    for version, _ in _MIGRATIONS:
        if not list(MIGRATIONS_DIR.glob(f"V{version}__*.sql")):
            missing.append(version)
    assert not missing, (
        f"no postgresql/migrations/game/V{{n}}__*.sql for game_migrations version(s): {missing}"
    )


def test_every_versioned_sql_file_has_a_matching_migration():
    known_versions = {version for version, _ in _MIGRATIONS}
    orphans = []
    for path in sorted(MIGRATIONS_DIR.glob("V*__*.sql")):
        m = re.match(r"V(\d+)__", path.name)
        assert m, f"unexpected migration filename shape: {path.name}"
        if int(m.group(1)) not in known_versions:
            orphans.append(path.name)
    assert not orphans, f"game/V*.sql file(s) with no matching game_migrations entry: {orphans}"


@pytest.mark.parametrize("version,var_name", _MIGRATIONS, ids=[f"V{v}" for v, _ in _MIGRATIONS])
def test_sql_file_statements_match_cpp_array(version: int, var_name: str):
    """[SF-GAME-11] For each game_migrations entry, the statements actually
    applied in-process (kGameMigrationV{N} in game_store.cpp) must be exactly
    the same DDL, in the same order, as postgresql/migrations/game/V{N}__*.sql
    — modulo whitespace formatting."""
    cpp_statements = [_normalize(s) for s in _extract_cpp_array(_CPP_SOURCE, var_name)]

    matches = list(MIGRATIONS_DIR.glob(f"V{version}__*.sql"))
    assert len(matches) == 1, (
        f"expected exactly one game/V{version}__*.sql, found {[m.name for m in matches]}"
    )
    sql_statements = [_normalize(s) for s in _extract_sql_file_statements(matches[0])]

    assert sql_statements == cpp_statements, (
        f"postgresql/migrations/game/{matches[0].name} has drifted from "
        f"{var_name} in game_store.cpp:\n"
        f"  .sql file:   {sql_statements}\n"
        f"  game_migrations: {cpp_statements}"
    )
