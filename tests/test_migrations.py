from __future__ import annotations

import importlib.util
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PERSISTENT_STORE_CPP = REPO_ROOT / "libs" / "six-feat-storage" / "src" / "persistent_store.cpp"
SCHEMA_SQL = REPO_ROOT / "postgresql" / "schema.sql"
EXPLAIN_SCRIPT = REPO_ROOT / "scripts" / "explain-hot-queries.py"


def _normalize(sql: str) -> str:
    sql = sql.strip()
    if sql.endswith(";"):
        sql = sql[:-1]
    return re.sub(r"\s+", " ", sql).strip()


def _extract_schema_statements(source: str) -> list[str]:
    """Операторы из kSchemaStatements в persistent_store.cpp, по порядку."""
    block_match = re.search(
        r"const std::vector<const char\*>\s+kSchemaStatements\s*=\s*\{(.*?)\};",
        source,
        re.DOTALL,
    )
    assert block_match, "could not find kSchemaStatements array in persistent_store.cpp"
    block = block_match.group(1)

    statements = []
    for m in re.finditer(r'R"SQL\((.*?)\)SQL"|"((?:[^"\\]|\\.)*)"', block, re.DOTALL):
        raw, plain = m.group(1), m.group(2)
        statements.append(raw if raw is not None else plain)
    return statements


def _extract_sql_file_statements(path: Path) -> list[str]:
    text = path.read_text()
    lines = [line.split("--", 1)[0] for line in text.splitlines()]
    text_no_comments = "\n".join(lines)
    return [s for s in text_no_comments.split(";") if s.strip()]


_CPP_SOURCE = PERSISTENT_STORE_CPP.read_text()


def test_schema_statements_match_schema_sql():
    """Единственный источник правды о схеме — postgresql/schema.sql.

    Приложение применяет её через зеркало kSchemaStatements в
    persistent_store.cpp (SF-DB-05). Реестра версий и миграций больше нет:
    файл один, версий в имени нет, каждая операция идемпотентна.
    """
    cpp_statements = [_normalize(s) for s in _extract_schema_statements(_CPP_SOURCE)]
    sql_statements = [_normalize(s) for s in _extract_sql_file_statements(SCHEMA_SQL)]

    assert sql_statements == cpp_statements, (
        f"postgresql/schema.sql has drifted from kSchemaStatements in "
        f"persistent_store.cpp:\n"
        f"  .sql file: {sql_statements}\n"
        f"  C++:       {cpp_statements}"
    )


def test_no_versioned_schema_files_remain():
    """Версии схемы отменены: V*.sql в репозитории больше не живут."""
    versioned = sorted(REPO_ROOT.glob("postgresql/**/V*__*.sql"))
    assert not versioned, f"versioned files still present: {[p.name for p in versioned]}"


def _load_explain_script():
    spec = importlib.util.spec_from_file_location("explain_hot_queries", EXPLAIN_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_explain_script_applies_the_single_schema_file():
    """Единственное место, где postgresql/schema.sql применяется напрямую —
    джоба «Perf — EXPLAIN hot queries». Скрипт обязан указывать на тот же
    файл, что и зеркало в C++: иначе проверка планов уедет от реальной
    схемы приложения.
    """
    script = _load_explain_script()
    assert script.SCHEMA_SQL.resolve() == SCHEMA_SQL.resolve()
