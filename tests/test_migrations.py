from __future__ import annotations

import re
from pathlib import Path
from typing import List, Tuple

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
PERSISTENT_STORE_CPP = REPO_ROOT / "libs" / "six-feat-storage" / "src" / "persistent_store.cpp"
MIGRATIONS_DIR = REPO_ROOT / "postgresql" / "migrations"


def _normalize(sql: str) -> str:
    sql = sql.strip()
    if sql.endswith(";"):
        sql = sql[:-1]
    return re.sub(r"\s+", " ", sql).strip()


def _extract_cpp_array(source: str, var_name: str) -> List[str]:
    block_match = re.search(
        rf"const std::vector<const char\*>\s+{re.escape(var_name)}\s*=\s*\{{(.*?)\}};",
        source,
        re.DOTALL,
    )
    assert block_match, f"could not find {var_name} array in persistent_store.cpp"
    block = block_match.group(1)

    statements = []
    for m in re.finditer(r'R"SQL\((.*?)\)SQL"|"((?:[^"\\]|\\.)*)"', block, re.DOTALL):
        raw, plain = m.group(1), m.group(2)
        statements.append(raw if raw is not None else plain)
    return statements


def _extract_migrations_list(source: str) -> List[Tuple[int, str]]:
    block_match = re.search(
        r"const std::vector<Migration>\s+kMigrations\s*=\s*\{(.*?)\};",
        source,
        re.DOTALL,
    )
    assert block_match, "could not find kMigrations array in persistent_store.cpp"
    block = block_match.group(1)

    pairs = re.findall(r"\{\s*(\d+)\s*,\s*(kMigrationV\d+)\s*\}", block)
    assert pairs, "kMigrations array is empty or unparseable"
    return [(int(version), var_name) for version, var_name in pairs]


def _extract_sql_file_statements(path: Path) -> List[str]:
    text = path.read_text()
    lines = [line.split("--", 1)[0] for line in text.splitlines()]
    text_no_comments = "\n".join(lines)
    return [s for s in text_no_comments.split(";") if s.strip()]


_CPP_SOURCE = PERSISTENT_STORE_CPP.read_text()
_MIGRATIONS = _extract_migrations_list(_CPP_SOURCE)


def test_every_migration_has_a_versioned_sql_file():
    missing = []
    for version, _ in _MIGRATIONS:
        if not list(MIGRATIONS_DIR.glob(f"V{version}__*.sql")):
            missing.append(version)
    assert not missing, (
        f"no postgresql/migrations/V{{n}}__*.sql for kMigrations version(s): {missing}"
    )


def test_every_versioned_sql_file_has_a_matching_migration():
    known_versions = {version for version, _ in _MIGRATIONS}
    orphans = []
    for path in sorted(MIGRATIONS_DIR.glob("V*__*.sql")):
        m = re.match(r"V(\d+)__", path.name)
        assert m, f"unexpected migration filename shape: {path.name}"
        if int(m.group(1)) not in known_versions:
            orphans.append(path.name)
    assert not orphans, f"V*.sql file(s) with no matching kMigrations entry: {orphans}"


@pytest.mark.parametrize("version,var_name", _MIGRATIONS, ids=[f"V{v}" for v, _ in _MIGRATIONS])
def test_sql_file_statements_match_cpp_array(version: int, var_name: str):
    cpp_statements = [_normalize(s) for s in _extract_cpp_array(_CPP_SOURCE, var_name)]

    matches = list(MIGRATIONS_DIR.glob(f"V{version}__*.sql"))
    assert len(matches) == 1, (
        f"expected exactly one V{version}__*.sql, found {[m.name for m in matches]}"
    )
    sql_statements = [_normalize(s) for s in _extract_sql_file_statements(matches[0])]

    assert sql_statements == cpp_statements, (
        f"postgresql/migrations/{matches[0].name} has drifted from "
        f"{var_name} in persistent_store.cpp:\n"
        f"  .sql file:   {sql_statements}\n"
        f"  kMigrations: {cpp_statements}"
    )
