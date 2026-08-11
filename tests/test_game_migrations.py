from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
GAME_STORE_CPP = REPO_ROOT / "services" / "game" / "src" / "core" / "game_store.cpp"
GAME_SCHEMA_SQL = REPO_ROOT / "postgresql" / "game" / "schema.sql"


def _normalize(sql: str) -> str:
    sql = sql.strip()
    if sql.endswith(";"):
        sql = sql[:-1]
    return re.sub(r"\s+", " ", sql).strip()


def _extract_schema_statements(source: str) -> list[str]:
    """Операторы из kGameSchema в game_store.cpp, по порядку."""
    block_match = re.search(
        r"const std::vector<const char\*>\s+kGameSchema\s*=\s*\{(.*?)\};",
        source,
        re.DOTALL,
    )
    assert block_match, "could not find kGameSchema array in game_store.cpp"
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


_CPP_SOURCE = GAME_STORE_CPP.read_text()


def test_schema_statements_match_schema_sql():
    """Единственный источник правды о схеме БД игры — postgresql/game/schema.sql.

    Приложение применяет её через зеркало kGameSchema в game_store.cpp.
    Реестра версий и миграций нет: файл один, сид достижений — идемпотентная
    часть бутстрапа, а не отдельная версия.
    """
    cpp_statements = [_normalize(s) for s in _extract_schema_statements(_CPP_SOURCE)]
    sql_statements = [_normalize(s) for s in _extract_sql_file_statements(GAME_SCHEMA_SQL)]

    assert sql_statements == cpp_statements, (
        f"postgresql/game/schema.sql has drifted from kGameSchema in "
        f"game_store.cpp:\n"
        f"  .sql file: {sql_statements}\n"
        f"  C++:       {cpp_statements}"
    )
