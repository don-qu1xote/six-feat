#!/usr/bin/env python3
"""Политика комментариев в репозитории.

Оставляем только:
  1. Прагмы и директивы (NOLINT, clang-format, noqa, type: ignore, shellcheck ...) — их едят линтеры и компиляторы.
  2. Doc-комментарии (Doxygen ///, //!, /**; JSDoc /**; Python-докстринги).
  3. Shebang, coding-декларации, dockerfile-директивы (# syntax=).
  4. Русские комментарии в построечных конфиг-файлах (.env, Makefile, CMake,
     Dockerfile, compose, shell-скрипты, SQL, nginx) — они помогают человеку
     собрать и поднять проект.

Всё остальное — пояснения в коде, английские комментарии, мусор — удаляется
(--fix) и считается нарушением (режим проверки, гоняется в CI и pre-commit).
"""

import argparse
import os
import re
import sys
import tokenize
from pathlib import Path

CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")

DECOR_RE = re.compile(r"^#[\s\u2500-\u257F#\-=_.|]*$")

DIRECTIVE_PATTERNS = {
    "cpp": [
        re.compile(r"^\s*//\s*NOLINT(?:NEXTLINE|BEGIN|END)?\b"),
        re.compile(r"^\s*//\s*IWYU\s+pragma:"),
        re.compile(r"^\s*//\s*clang-format\s+(off|on)\b"),
        re.compile(r"^\s*//\s*namespace\b"),
    ],
    "py": [
        re.compile(r"^\s*#!"),
        re.compile(r"^\s*#\s*noqa(?::\s*\S+)?\b"),
        re.compile(r"^\s*#\s*type:\s*ignore"),
        re.compile(r"^\s*#\s*pragma:\s*no\s+cover"),
        re.compile(r"^\s*#\s*fmt:\s*(off|on)\b"),
        re.compile(r"^\s*#\s*ruff\b"),
        re.compile(r"^\s*#\s*pylint:\s*disable"),
        re.compile(r"^\s*#\s*pylint:\s*enable"),
        re.compile(r"^\s*#\s*pyright:\s*ignore"),
        re.compile(r"^\s*#\s*mypy:\s*ignore"),
        re.compile(r"^\s*#.*coding[=:]"),
    ],
    "js": [
        re.compile(r"^\s*//\s*eslint-disable(?:-next-line|-line)?\b"),
        re.compile(r"^\s*//\s*eslint-enable\b"),
        re.compile(r"^\s*//\s*prettier-ignore"),
        re.compile(r"^\s*//\s*istanbul\s+ignore"),
        re.compile(r"^\s*//\s*@ts-ignore"),
        re.compile(r"^\s*//\s*@vitest-environment\b"),
        re.compile(r"^\s*//\s*@ts-nocheck"),
        re.compile(r"^\s*//\s*@ts-check"),
        re.compile(r"^\s*//\s*@license"),
        re.compile(r"^\s*//\s*@copyright"),
    ],
    "sh": [
        re.compile(r"^\s*#!"),
        re.compile(r"^\s*#\s*shellcheck\b"),
    ],
    "dockerfile": [
        re.compile(r"^\s*#\s*syntax="),
    ],
    "sql": [
        re.compile(r"^\s*#!"),
    ],
}

BLOCK_DIRECTIVE_PATTERNS = {
    "cpp": [
        re.compile(r"/\*\s*clang-format\s+(off|on)\s*\*/"),
        re.compile(r"/\*\s*IWYU\s+pragma:.*\*/"),
    ],
    "js": [
        re.compile(r"/\*\s*eslint-disable(?:-next-line)?\s*\*/"),
        re.compile(r"/\*\s*eslint-enable\s*\*/"),
        re.compile(r"/\*\s*prettier-ignore\s*\*/"),
        re.compile(r"/\*\s*istanbul\s+ignore\s*\*/"),
        re.compile(r"/\*\s*@ts-ignore\s*\*/"),
        re.compile(r"/\*\s*@ts-nocheck\s*\*/"),
    ],
}


def is_directive(text: str, lang: str) -> bool:
    for pat in DIRECTIVE_PATTERNS.get(lang, []):
        if pat.match(text):
            return True
    for pat in BLOCK_DIRECTIVE_PATTERNS.get(lang, []):
        if pat.search(text):
            return True
    return False


def has_cyrillic(text: str) -> bool:
    return bool(CYRILLIC_RE.search(text))


def is_doc_comment(text: str, lang: str) -> bool:
    stripped = text.lstrip()
    if lang == "cpp":
        return (
            stripped.startswith("///")
            or stripped.startswith("//!")
            or stripped.startswith("/**")
            or stripped.startswith("/*!")
        )
    if lang == "js":
        return stripped.startswith("/**") or stripped.startswith("///")
    return False


def is_build_file(path: Path) -> bool:
    name = path.name
    if name in {
        "Makefile",
        "CMakeLists.txt",
        "Dockerfile",
        "docker-compose.yml",
        "docker-compose.yaml",
        "pyproject.toml",
        "pytest.ini",
        ".gitignore",
        ".dockerignore",
        ".env.example",
    }:
        return True
    if name.startswith("Dockerfile"):
        return True
    if name.startswith("docker-entrypoint"):
        return True
    if name.endswith(".env"):
        return True
    ext = path.suffix
    if ext in {".cmake", ".sh", ".sql", ".conf", ".toml", ".ini"}:
        return True
    if ext in {".yaml", ".yml"}:
        parts = path.parts
        if "docker-compose" in name:
            return True
        if "config" in parts or "schemas" in parts:
            return True
        if name == "static_config.yaml":
            return True
        return False
    return False


def is_keep(text: str, lang: str, build_file: bool) -> bool:
    stripped = text.strip()
    if not stripped:
        return build_file
    if is_directive(stripped, lang):
        return True
    if is_doc_comment(text, lang):
        return True
    if build_file and (
        has_cyrillic(stripped) or DECOR_RE.match(stripped) or re.fullmatch(r"[#\-_=\s]+", stripped)
    ):
        return True
    return False


def russian_comment_blocks(source: str) -> set[int]:
    """Номера строк (1-based) комментариев, чей непрерывный блок содержит кириллицу.

    Для конфиг-файлов: переведённый блок может содержать чисто технические
    строки (сигнатуры, пути, флаги команд) без единой буквы кириллицы —
    например `# -DSCHEMA_YAML=...` внутри русского абзаца. Такую строку
    нельзя резать: блок в целом построечный и русский.
    """
    lines = source.splitlines()
    keeps: set[int] = set()
    i = 0
    n = len(lines)
    while i < n:
        if lines[i].lstrip().startswith("#"):
            j = i
            block: list[tuple[int, str]] = []
            while j < n and lines[j].lstrip().startswith("#"):
                block.append((j, lines[j]))
                j += 1
            if any(has_cyrillic(l) for _, l in block):
                keeps.update(k + 1 for k, _ in block)
            i = j
        else:
            i += 1
    return keeps


def extract_cpp_line_comments(source: str) -> list[tuple[int, int, int, str]]:
    results: list[tuple[int, int, int, str]] = []
    i = 0
    n = len(source)
    line = 1
    in_string = False
    in_char = False
    string_char = ""
    in_raw_string = False
    raw_delim = ""

    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""

        if in_raw_string:
            if ch == ")" and source[i : i + len(raw_delim) + 1] == ")" + raw_delim:
                i += len(raw_delim) + 2
                in_raw_string = False
                continue
            if ch == "\n":
                line += 1
            i += 1
            continue

        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == string_char:
                in_string = False
            if ch == "\n":
                line += 1
            i += 1
            continue

        if in_char:
            if ch == "\\":
                i += 2
                continue
            if ch == string_char:
                in_char = False
            if ch == "\n":
                line += 1
            i += 1
            continue

        if ch == "/" and nxt == "/":
            start_col = i
            rest = source[i + 2 :]
            nl_idx = rest.find("\n")
            if nl_idx == -1:
                end = len(rest)
            else:
                end = nl_idx + 1
            results.append((line, start_col, i + 2 + end, "//" + rest[:end]))
            i += 2 + end
            if nl_idx != -1:
                line += 1
            continue

        if ch == "R" and nxt == '"':
            j = i + 2
            delim = ""
            while j < n and source[j] != "(":
                delim += source[j]
                j += 1
            if j < n:
                in_raw_string = True
                raw_delim = delim
                i = j + 1
                continue

        if ch == '"' or ch == "'":
            if ch == '"':
                in_string = True
                string_char = '"'
            else:
                in_char = True
                string_char = "'"
            i += 1
            continue

        if ch == "\n":
            line += 1
        i += 1

    return results


def extract_cpp_block_comments(source: str) -> list[tuple[int, int, int, str]]:
    results: list[tuple[int, int, int, str]] = []
    i = 0
    n = len(source)
    line = 1
    in_string = False
    in_char = False
    string_char = ""
    in_raw_string = False
    raw_delim = ""
    in_block_comment = False
    block_start_line = 0
    block_start_col = 0
    block_text = ""

    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""

        if in_block_comment:
            if ch == "*" and nxt == "/":
                block_text += "*/"
                results.append((block_start_line, block_start_col, i + 2, block_text))
                in_block_comment = False
                i += 2
                continue
            if ch == "\n":
                block_text += "\n"
                block_start_line += 1
            else:
                block_text += ch
            i += 1
            continue

        if in_raw_string:
            if ch == ")" and source[i : i + len(raw_delim) + 1] == ")" + raw_delim:
                i += len(raw_delim) + 2
                in_raw_string = False
                continue
            if ch == "\n":
                line += 1
            i += 1
            continue

        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == string_char:
                in_string = False
            if ch == "\n":
                line += 1
            i += 1
            continue

        if in_char:
            if ch == "\\":
                i += 2
                continue
            if ch == string_char:
                in_char = False
            if ch == "\n":
                line += 1
            i += 1
            continue

        if ch == "/" and nxt == "*":
            in_block_comment = True
            block_start_line = line
            block_start_col = i
            block_text = "/*"
            i += 2
            continue

        if ch == '"' or ch == "'":
            if ch == '"':
                in_string = True
                string_char = '"'
            else:
                in_char = True
                string_char = "'"
            i += 1
            continue

        if ch == "R" and nxt == '"':
            j = i + 2
            delim = ""
            while j < n and source[j] != "(":
                delim += source[j]
                j += 1
            if j < n:
                in_raw_string = True
                raw_delim = delim
                i = j + 1
                continue

        if ch == "\n":
            line += 1
        i += 1

    return results


def extract_py_line_comments(source: str) -> list[tuple[int, int, str]]:
    results: list[tuple[int, int, str]] = []
    try:
        tokens = tokenize.generate_tokens(iter(source.splitlines(keepends=True)).__next__)
    except tokenize.TokenError:
        return results

    for tok in tokens:
        if tok.type == tokenize.COMMENT:
            results.append((tok.start[0], tok.start[1], tok.string))
    return results


_JS_REGEX_PREV_KEYWORDS = (
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "case",
    "do",
    "else",
    "yield",
    "await",
)


def js_regex_starts_at(source: str, i: int) -> bool:

    j = i - 1
    while j >= 0 and source[j] in " \t\r\n":
        j -= 1
    if j < 0:
        return True
    prev = source[j]
    if prev in "(,=:[!&|?{};+-*%~^<>":
        return True
    if prev.isalnum() or prev == "_" or prev == "$":
        k = j
        while k >= 0 and (source[k].isalnum() or source[k] in "_$"):
            k -= 1
        return source[k + 1 : j + 1] in _JS_REGEX_PREV_KEYWORDS
    return False


def js_skip_regex(source: str, i: int) -> int:

    n = len(source)
    j = i + 1
    in_class = False
    while j < n:
        ch = source[j]
        if ch == "\\":
            j += 2
            continue
        if ch == "\n":
            return i + 1
        if in_class:
            if ch == "]":
                in_class = False
        elif ch == "[":
            in_class = True
        elif ch == "/":
            return j + 1
        j += 1
    return i + 1


def extract_js_line_comments(source: str) -> list[tuple[int, int, int, str]]:
    results: list[tuple[int, int, int, str]] = []
    i = 0
    n = len(source)
    line = 1
    in_string = False
    string_char = ""
    in_template = False
    template_depth = 0

    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""

        if in_template:
            if ch == "`" and template_depth == 0:
                in_template = False
            elif ch == "$" and nxt == "{" and template_depth == 0:
                template_depth += 1
                i += 2
                continue
            if ch == "\n":
                line += 1
            i += 1
            continue

        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == string_char:
                in_string = False
            if ch == "\n":
                line += 1
            i += 1
            continue

        if ch == "/" and nxt == "/":
            start_col = i
            rest = source[i + 2 :]
            nl_idx = rest.find("\n")
            if nl_idx == -1:
                end = len(rest)
            else:
                end = nl_idx + 1
            results.append((line, start_col, i + 2 + end, "//" + rest[:end]))
            i += 2 + end
            if nl_idx != -1:
                line += 1
            continue

        if ch == "/" and nxt != "*" and js_regex_starts_at(source, i):
            i = js_skip_regex(source, i)
            continue

        if ch == "`":
            in_template = True
            i += 1
            continue

        if ch == '"' or ch == "'":
            in_string = True
            string_char = ch
            i += 1
            continue

        if ch == "\n":
            line += 1
        i += 1

    return results


def extract_js_block_comments(source: str) -> list[tuple[int, int, int, str]]:
    results: list[tuple[int, int, int, str]] = []
    i = 0
    n = len(source)
    line = 1
    in_string = False
    string_char = ""
    in_template = False
    template_depth = 0
    in_block_comment = False
    block_start_line = 0
    block_start_col = 0
    block_text = ""

    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""

        if in_block_comment:
            if ch == "*" and nxt == "/":
                block_text += "*/"
                results.append((block_start_line, block_start_col, i + 2, block_text))
                in_block_comment = False
                i += 2
                continue
            if ch == "\n":
                block_text += "\n"
                block_start_line += 1
            else:
                block_text += ch
            i += 1
            continue

        if in_template:
            if ch == "`" and template_depth == 0:
                in_template = False
            elif ch == "$" and nxt == "{" and template_depth == 0:
                template_depth += 1
                i += 2
                continue
            if ch == "\n":
                line += 1
            i += 1
            continue

        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == string_char:
                in_string = False
            if ch == "\n":
                line += 1
            i += 1
            continue

        if ch == "/" and nxt == "*":
            in_block_comment = True
            block_start_line = line
            block_start_col = i
            block_text = "/*"
            i += 2
            continue

        if ch == "/" and nxt == "/":
            rest = source[i + 2 :]
            nl_idx = rest.find("\n")
            i += 2 + (len(rest) if nl_idx == -1 else nl_idx)
            continue

        if ch == "/" and js_regex_starts_at(source, i):
            i = js_skip_regex(source, i)
            continue

        if ch == "`":
            in_template = True
            i += 1
            continue

        if ch == '"' or ch == "'":
            in_string = True
            string_char = ch
            i += 1
            continue

        if ch == "\n":
            line += 1
        i += 1

    return results


def extract_css_block_comments(source: str) -> list[tuple[int, int, int, str]]:
    results: list[tuple[int, int, int, str]] = []
    i = 0
    n = len(source)
    line = 1
    while i < n:
        if source[i : i + 2] == "/*":
            block_start_line = line
            block_start_col = i
            block_text = "/*"
            i += 2
            while i < n:
                if source[i] == "\n":
                    line += 1
                    block_text += "\n"
                elif source[i : i + 2] == "*/":
                    block_text += "*/"
                    results.append((block_start_line, block_start_col, i + 2, block_text))
                    i += 2
                    break
                else:
                    block_text += source[i]
                i += 1
        else:
            if source[i] == "\n":
                line += 1
            i += 1
    return results


def extract_html_comments(source: str) -> list[tuple[int, int, int, str]]:
    results: list[tuple[int, int, int, str]] = []
    i = 0
    n = len(source)
    line = 1
    while i < n:
        if source[i : i + 4] == "<!--":
            block_start_line = line
            block_start_col = i
            block_text = "<!--"
            i += 4
            while i < n:
                if source[i] == "\n":
                    line += 1
                    block_text += "\n"
                elif source[i : i + 3] == "-->":
                    block_text += "-->"
                    results.append((block_start_line, block_start_col, i + 3, block_text))
                    i += 3
                    break
                else:
                    block_text += source[i]
                i += 1
        else:
            if source[i] == "\n":
                line += 1
            i += 1
    return results


def extract_hash_line_comments(
    source: str, flow_prev: str = " \t[{,:"
) -> list[tuple[int, int, str]]:
    """Комментарии `#` вне кавычек ('...' / "...") и вне '\n'."""
    results: list[tuple[int, int, str]] = []
    lines = source.splitlines(keepends=True)
    for lineno, line in enumerate(lines, 1):
        quote: str | None = None
        j = 0
        while j < len(line):
            ch = line[j]
            if quote:
                if ch == "\\" and quote == '"':
                    j += 2
                    continue
                if ch == quote:
                    quote = None
                j += 1
                continue
            if ch in "'\"":
                quote = ch
                j += 1
                continue
            if ch == "#":
                if j == 0 or line[j - 1] in flow_prev:
                    results.append((lineno, j, line[j:]))
                break
            j += 1
    return results


def extract_yaml_line_comments(source: str) -> list[tuple[int, int, str]]:
    """Комментарии `#` вне кавычек и вне block-scalar (|, >) содержимого."""
    results: list[tuple[int, int, str]] = []
    lines = source.splitlines(keepends=True)
    block_indent: int | None = None
    for lineno, line in enumerate(lines, 1):
        indent = len(line) - len(line.lstrip(" "))
        if block_indent is not None:
            if indent > block_indent:
                continue
            block_indent = None

        col = -1
        quote: str | None = None
        j = 0
        while j < len(line):
            ch = line[j]
            if quote:
                if ch == "\\" and quote == '"':
                    j += 2
                    continue
                if ch == quote:
                    quote = None
                j += 1
                continue
            if ch in "'\"":
                quote = ch
                j += 1
                continue
            if ch == "#":
                if j == 0 or line[j - 1] in " \t[{,:":
                    col = j
                break
            j += 1

        content = line[:col] if col != -1 else line.rstrip("\n")
        if re.search(r"[>|][+-]?[0-9]*[+-]?\s*$", content):
            block_indent = indent

        if col != -1:
            results.append((lineno, col, line[col:]))
    return results


def extract_cmake_comments(source: str) -> list[tuple[int, int, int, str]]:
    """Строковые `#`-комментарии, скобочные `#[[ ... ]]`-комментарии; вне кавычек и bracket-аргументов."""
    results: list[tuple[int, int, int, str]] = []
    lines = source.splitlines(keepends=True)
    line_offsets = [0]
    for l in lines:
        line_offsets.append(line_offsets[-1] + len(l))

    i = 0
    n = len(source)
    line = 1
    quote: str | None = None
    in_bracket = False
    bracket_eq = ""
    in_bracket_comment = False
    block_start_line = 0
    block_start_col = 0
    block_text = ""

    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""

        if in_bracket_comment:
            if ch == "\n":
                line += 1
            if source.startswith("]" + bracket_eq + "]", i):
                block_text += "]" + bracket_eq + "]"
                results.append(
                    (block_start_line, block_start_col, i + 2 + len(bracket_eq), block_text)
                )
                in_bracket_comment = False
                i += 2 + len(bracket_eq)
                continue
            block_text += ch
            i += 1
            continue

        if in_bracket:
            if ch == "\n":
                line += 1
            if source.startswith("]" + bracket_eq + "]", i):
                in_bracket = False
                bracket_eq = ""
                i += 2 + len(bracket_eq)
                continue
            i += 1
            continue

        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            if ch == "\n":
                line += 1
            i += 1
            continue

        if ch == '"':
            quote = '"'
            i += 1
            continue

        if ch == "#" and nxt == "[" and i + 2 < n:
            eq = 0
            j = i + 1
            while j < n and source[j] == "=":
                eq += 1
                j += 1
            if j < n and source[j] == "[":
                in_bracket_comment = True
                bracket_eq = "=" * eq
                block_start_line = line
                block_start_col = i
                block_text = "#[" + bracket_eq + "["
                i = j + 1
                continue

        if ch == "[" and i + 1 < n:
            eq = 0
            j = i + 1
            while j < n and source[j] == "=":
                eq += 1
                j += 1
            if j < n and source[j] == "[":
                in_bracket = True
                bracket_eq = "=" * eq
                i = j + 1
                continue

        if ch == "#":
            nl = source.find("\n", i)
            end = n if nl == -1 else nl
            results.append((line, i, end, source[i:end]))
            i = end
            if nl != -1:
                i += 1
                line += 1
            continue

        if ch == "\n":
            line += 1
        i += 1

    return results


def extract_sql_comments(source: str) -> list[tuple[int, int, int, str]]:
    """`--` и `/* */` комментарии вне строковых литералов."""
    results: list[tuple[int, int, int, str]] = []
    i = 0
    n = len(source)
    line = 1
    in_string = False
    in_block = False
    block_start_line = 0
    block_start_col = 0
    block_text = ""

    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""

        if in_block:
            if ch == "*" and nxt == "/":
                block_text += "*/"
                results.append((block_start_line, block_start_col, i + 2, block_text))
                in_block = False
                i += 2
                continue
            if ch == "\n":
                line += 1
            block_text += ch
            i += 1
            continue

        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == "'":
                in_string = False
            if ch == "\n":
                line += 1
            i += 1
            continue

        if ch == "'":
            in_string = True
            i += 1
            continue

        if ch == "-" and nxt == "-":
            nl = source.find("\n", i)
            end = n if nl == -1 else nl
            results.append((line, i, end, source[i:end]))
            i = end
            if nl != -1:
                i += 1
                line += 1
            continue

        if ch == "/" and nxt == "*":
            in_block = True
            block_start_line = line
            block_start_col = i
            block_text = "/*"
            i += 2
            continue

        if ch == "\n":
            line += 1
        i += 1

    return results


def get_lang(ext: str) -> str | None:
    if ext == ".py":
        return "py"
    if ext in (".cpp", ".hpp", ".h", ".cc", ".cxx", ".c"):
        return "cpp"
    if ext in (".js", ".mjs", ".cjs"):
        return "js"
    if ext == ".css":
        return "css"
    if ext == ".html":
        return "html"
    if ext in (".yaml", ".yml"):
        return "yaml"
    if ext in (".cmake",):
        return "cmake"
    if ext in (".sh", ".bash"):
        return "sh"
    if ext in (".sql",):
        return "sql"
    if ext in (".conf", ".toml", ".ini", ".env"):
        return "hash"
    return None


def get_lang_by_name(name: str) -> str | None:
    if name == "Makefile" or name.startswith("docker-entrypoint"):
        return "hash"
    if name.startswith("Dockerfile"):
        return "dockerfile"
    if name == "CMakeLists.txt":
        return "cmake"
    return None


def line_start_offsets(lines: list[str]) -> list[int]:
    starts = [0]
    for l in lines[:-1]:
        starts.append(starts[-1] + len(l) + 1)
    return starts


def strip_block_comment(lines, line_starts, lineno, col, end_col, text) -> None:
    start_idx = lineno - 1
    end_idx = start_idx + text.count("\n")
    rel_col = col - line_starts[start_idx]
    rel_end = end_col - line_starts[end_idx]
    if start_idx == end_idx:
        line = lines[start_idx]
        lines[start_idx] = line[:rel_col] + line[rel_end:]
    else:
        lines[start_idx] = lines[start_idx][:rel_col]
        for idx in range(start_idx + 1, end_idx):
            lines[idx] = ""
        if end_idx < len(lines):
            lines[end_idx] = lines[end_idx][rel_end:]


def strip_line_comment(source: str, lineno: int, col: int) -> str:
    lines = source.split("\n")
    line_idx = lineno - 1
    if line_idx < len(lines):
        line = lines[line_idx]
        lines[line_idx] = line[:col].rstrip()
    return "\n".join(lines)


def strip_abs_line_comment(source: str, lineno: int, col: int) -> str:
    """То же, но col — абсолютная позиция в файле (cpp/js-экстракторы)."""
    lines = source.split("\n")
    line_idx = lineno - 1
    if line_idx < len(lines):
        rel_col = col - line_start_offsets(lines)[line_idx]
        lines[line_idx] = lines[line_idx][:rel_col].rstrip()
    return "\n".join(lines)


def strip_file(filepath: str, build_file: bool) -> int:
    path = Path(filepath)
    ext = path.suffix
    lang = get_lang(ext) or get_lang_by_name(path.name)
    if lang is None:
        return 0

    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return 0

    original = source
    removed = 0

    keep_lines: set[int] = set()
    if build_file and lang in ("yaml", "cmake", "sql", "sh", "hash", "dockerfile"):
        keep_lines = russian_comment_blocks(source)

    def removable(lineno: int, text: str) -> bool:
        return not is_keep(text, lang, build_file) and lineno not in keep_lines

    if lang == "py":
        for lineno, col, text in reversed(extract_py_line_comments(source)):
            if removable(lineno, text):
                source = strip_line_comment(source, lineno, col)
                removed += 1
    elif lang == "cpp":
        for lineno, col, end_col, text in reversed(extract_cpp_line_comments(source)):
            if not is_keep(text, lang, build_file):
                source = strip_abs_line_comment(source, lineno, col)
                removed += 1
        for lineno, col, end_col, text in reversed(extract_cpp_block_comments(source)):
            if not is_keep(text, lang, build_file):
                lines = source.split("\n")
                strip_block_comment(lines, line_start_offsets(lines), lineno, col, end_col, text)
                source = "\n".join(lines)
                removed += 1
    elif lang == "js":
        for lineno, col, end_col, text in reversed(extract_js_line_comments(source)):
            if not is_keep(text, lang, build_file):
                source = strip_abs_line_comment(source, lineno, col)
                removed += 1
        for lineno, col, end_col, text in reversed(extract_js_block_comments(source)):
            if not is_keep(text, lang, build_file):
                lines = source.split("\n")
                strip_block_comment(lines, line_start_offsets(lines), lineno, col, end_col, text)
                source = "\n".join(lines)
                removed += 1
    elif lang == "css":
        for lineno, col, end_col, text in reversed(extract_css_block_comments(source)):
            if not is_keep(text, lang, build_file):
                lines = source.split("\n")
                strip_block_comment(lines, line_start_offsets(lines), lineno, col, end_col, text)
                source = "\n".join(lines)
                removed += 1
    elif lang == "html":
        for lineno, col, end_col, text in reversed(extract_html_comments(source)):
            if not is_keep(text, lang, build_file):
                lines = source.split("\n")
                strip_block_comment(lines, line_start_offsets(lines), lineno, col, end_col, text)
                source = "\n".join(lines)
                removed += 1
    elif lang == "yaml":
        for lineno, col, text in reversed(extract_yaml_line_comments(source)):
            if removable(lineno, text):
                source = strip_line_comment(source, lineno, col)
                removed += 1
    elif lang == "cmake":
        for lineno, col, end_col, text in reversed(extract_cmake_comments(source)):
            if removable(lineno, text):
                source = strip_line_comment(source, lineno, col)
                removed += 1
    elif lang == "sql":
        for lineno, col, end_col, text in reversed(extract_sql_comments(source)):
            if removable(lineno, text):
                if "\n" in text:
                    lines = source.split("\n")
                    strip_block_comment(
                        lines, line_start_offsets(lines), lineno, col, end_col, text
                    )
                    source = "\n".join(lines)
                else:
                    source = strip_line_comment(source, lineno, col)
                removed += 1
    elif lang in ("sh", "hash", "dockerfile"):
        for lineno, col, text in reversed(extract_hash_line_comments(source)):
            if removable(lineno, text):
                source = strip_line_comment(source, lineno, col)
                removed += 1

    if source != original:
        path.write_text(source, encoding="utf-8")

    return removed


def check_file(filepath: str, build_file: bool) -> list[str]:
    path = Path(filepath)
    ext = path.suffix
    lang = get_lang(ext) or get_lang_by_name(path.name)
    if lang is None:
        return []

    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []

    violations: list[str] = []

    keep_lines: set[int] = set()
    if build_file and lang in ("yaml", "cmake", "sql", "sh", "hash", "dockerfile"):
        keep_lines = russian_comment_blocks(source)

    def line_violations(comments) -> None:
        for item in comments:
            if len(item) == 3:
                lineno, col, text = item
            else:
                lineno, col, _end_col, text = item
            if not is_keep(text, lang, build_file) and lineno not in keep_lines:
                violations.append(f"{filepath}:{lineno}: {text.strip()[:80]}")

    if lang == "py":
        line_violations(extract_py_line_comments(source))
    elif lang == "cpp":
        line_violations(extract_cpp_line_comments(source))
        line_violations(extract_cpp_block_comments(source))
    elif lang == "js":
        line_violations(extract_js_line_comments(source))
        line_violations(extract_js_block_comments(source))
    elif lang == "css":
        line_violations(extract_css_block_comments(source))
    elif lang == "html":
        line_violations(extract_html_comments(source))
    elif lang == "yaml":
        line_violations(extract_yaml_line_comments(source))
    elif lang == "cmake":
        line_violations(extract_cmake_comments(source))
    elif lang == "sql":
        line_violations(extract_sql_comments(source))
    elif lang in ("sh", "hash"):
        line_violations(extract_hash_line_comments(source))

    return violations


EXCLUDED_DIRS = {
    ".git",
    "__pycache__",
    "node_modules",
    "vendor",
    "build",
    "build-test",
    "build-unit",
    "dist",
    "coverage",
    ".opencode",
    ".github",
    ".githooks",
    "observability",
    "docs",
    ".hypothesis",
    ".pgdata",
    ".pytest_cache",
    ".ruff_cache",
    "loadtest/output",
}

HANDLED_EXTS = {
    ".cpp",
    ".hpp",
    ".h",
    ".cc",
    ".cxx",
    ".c",
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".css",
    ".html",
    ".yaml",
    ".yml",
    ".cmake",
    ".sh",
    ".bash",
    ".sql",
    ".conf",
    ".toml",
    ".ini",
    ".env",
}

HANDLED_NAMES = {"Makefile", "CMakeLists.txt", "Dockerfile", "docker-entrypoint-common.sh"}


def collect_files(targets: list[str]) -> list[str]:
    files: list[str] = []
    for target in targets:
        p = Path(target)
        if p.is_file():
            files.append(str(p))
        elif p.is_dir():
            for root, dirs, fnames in os.walk(target):
                dirs[:] = [
                    d
                    for d in dirs
                    if d not in EXCLUDED_DIRS
                    and not (d.startswith("build") or d.startswith(".build"))
                ]
                for fn in fnames:
                    if fn == ".env":
                        continue
                    if (
                        Path(fn).suffix in HANDLED_EXTS
                        or fn in HANDLED_NAMES
                        or fn.startswith("Dockerfile")
                    ):
                        files.append(os.path.join(root, fn))
    return files


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Удаляет/проверяет комментарии, не нужные для сборки (прагмы и doc-комментарии остаются)"
    )
    parser.add_argument(
        "paths", nargs="*", help="Files or directories to check (default: whole repo)"
    )
    parser.add_argument("--fix", action="store_true", help="Remove non-build comments")
    args = parser.parse_args()

    targets = args.paths or ["."]
    files = sorted(collect_files(targets))

    if args.fix:
        total_removed = 0
        analyzed = 0
        for f in files:
            analyzed += 1
            if analyzed % 50 == 1 or analyzed == len(files):
                print(f"check_comments: fixing {f} ({analyzed}/{len(files)})", file=sys.stderr)
            removed = strip_file(f, is_build_file(Path(f)))
            total_removed += removed
        print(
            f"check_comments: removed {total_removed} non-build comments from {analyzed} files",
            file=sys.stderr,
        )
        return 0

    all_violations: list[str] = []
    analyzed = 0
    for f in files:
        analyzed += 1
        if analyzed % 50 == 1 or analyzed == len(files):
            print(f"check_comments: analyzing {f} ({analyzed}/{len(files)})", file=sys.stderr)
        all_violations.extend(check_file(f, is_build_file(Path(f))))

    print(f"check_comments: analyzed {analyzed} files", file=sys.stderr)

    if all_violations:
        print(f"Found {len(all_violations)} comment violations (non-build):")
        for v in all_violations:
            print(v)
        return 1

    print("All comments are build-necessary (directives, doc, or Russian in build configs).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
