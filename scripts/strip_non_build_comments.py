#!/usr/bin/env python3
import argparse
import ast
import os
import re
import sys
import tokenize
from io import StringIO
from pathlib import Path

CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")

CPP_DIRECTIVE_RE = re.compile(
    r"^\s*//\s*(NOLINT(?:NEXTLINE)?\b|IWYU\s+pragma:|clang-format\s+(off|on)\b|namespace\b)"
)
CPP_BLOCK_DIRECTIVE_RE = re.compile(r"/\*\s*(clang-format\s+(off|on)\b|IWYU\s+pragma:)")

PY_DIRECTIVE_RE = re.compile(
    r"^\s*#\s*(noqa(?::\s*\S+)?\b|type:\s*ignore\b|pragma:\s*no\s+cover\b|"
    r"fmt:\s*(off|on)\b|ruff\b|pylint:\s*(disable|enable)\b|"
    r"pyright:\s*ignore\b|mypy:\s*ignore\b)"
)
PY_SHEBANG_RE = re.compile(r"^#!")

JS_LINE_DIRECTIVE_RE = re.compile(
    r"^\s*//\s*(eslint-disable(?:-next-line|-line)?\b|eslint-enable\b|"
    r"prettier-ignore\b|istanbul\s+ignore\b|@ts-ignore\b|@vitest-environment\b|"
    r"@ts-nocheck\b|@ts-check\b|@license\b|@copyright\b)"
)
JS_BLOCK_DIRECTIVE_RE = re.compile(
    r"/\*\s*(eslint-disable(?:-next-line)?\b|eslint-enable\b|"
    r"prettier-ignore\b|istanbul\s+ignore\b|@ts-ignore\b|@vitest-environment\b|"
    r"@ts-nocheck\b)\s*\*/"
)


def is_cpp_directive(text: str) -> bool:
    return bool(CPP_DIRECTIVE_RE.match(text) or CPP_BLOCK_DIRECTIVE_RE.search(text))


def is_py_directive(text: str, lineno: int) -> bool:
    if lineno == 1 and PY_SHEBANG_RE.match(text):
        return True
    return bool(PY_DIRECTIVE_RE.match(text))


def is_js_directive(text: str) -> bool:
    return bool(JS_LINE_DIRECTIVE_RE.match(text) or JS_BLOCK_DIRECTIVE_RE.search(text))


def is_directive(text: str, lang: str, lineno: int = 0) -> bool:
    if lang == "cpp":
        return is_cpp_directive(text)
    if lang == "py":
        return is_py_directive(text, lineno)
    if lang == "js":
        return is_js_directive(text)
    return False


def has_cyrillic(text: str) -> bool:
    return bool(CYRILLIC_RE.search(text))


def strip_cpp(source: str) -> str:
    out: list[str] = []
    i = 0
    n = len(source)
    line = 1
    line_buf: list[str] = []

    def _flush_line_buf() -> None:
        out.extend(line_buf)
        line_buf.clear()

    while i < n:
        ch = source[i]

        if i + 1 < n and ch == "/" and source[i + 1] == "/":
            comment_start = i
            while i < n and source[i] != "\n":
                i += 1
            comment_text = source[comment_start:i]
            if is_directive(comment_text, "cpp"):
                _flush_line_buf()
                out.append(comment_text)
            else:
                line_content = "".join(line_buf)
                if line_content.strip() == "":
                    line_buf.clear()
                    if i < n and source[i] == "\n":
                        i += 1
                else:
                    _flush_line_buf()
            continue

        if i + 1 < n and ch == "/" and source[i + 1] == "*":
            _flush_line_buf()
            block_start = i
            i += 2
            while i < n:
                if i + 1 < n and source[i] == "*" and source[i + 1] == "/":
                    i += 2
                    break
                if source[i] == "\n":
                    line += 1
                i += 1
            block_text = source[block_start:i]
            if is_directive(block_text, "cpp"):
                out.append(block_text)
            continue

        if ch == "R" and i + 1 < n and source[i + 1] == '"':
            _flush_line_buf()
            j = i + 2
            delim = ""
            while j < n and source[j] != "(":
                delim += source[j]
                j += 1
            if j < n:
                out.append(source[i : j + 1])
                i = j + 1
                close = ")" + delim + '"'
                while i < n:
                    if source[i : i + len(close)] == close:
                        out.append(source[i : i + len(close)])
                        i += len(close)
                        break
                    if source[i] == "\n":
                        line += 1
                    out.append(source[i])
                    i += 1
                continue

        if ch == '"':
            _flush_line_buf()
            out.append(ch)
            i += 1
            while i < n:
                if source[i] == "\\":
                    out.append(source[i : i + 2])
                    i += 2
                    continue
                if source[i] == '"':
                    out.append(ch)
                    i += 1
                    break
                if source[i] == "\n":
                    line += 1
                out.append(source[i])
                i += 1
            continue

        if ch == "'":
            _flush_line_buf()
            out.append(ch)
            i += 1
            while i < n:
                if source[i] == "\\":
                    out.append(source[i : i + 2])
                    i += 2
                    continue
                if source[i] == "'":
                    out.append(ch)
                    i += 1
                    break
                if source[i] == "\n":
                    line += 1
                out.append(source[i])
                i += 1
            continue

        if ch == "\n":
            line += 1
            _flush_line_buf()
            out.append(ch)
            i += 1
            continue

        line_buf.append(ch)
        i += 1

    _flush_line_buf()
    return "".join(out)


def strip_py(source: str) -> str:
    lines = source.split("\n")

    docstring_lines: set[int] = set()
    try:
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)):
                body = node.body
                if body and isinstance(body[0], ast.Expr):
                    val = body[0].value
                    is_docstring = False
                    if isinstance(val, ast.Constant) and isinstance(val.value, str):
                        is_docstring = True
                    elif hasattr(ast, "Str") and isinstance(val, ast.Str):
                        is_docstring = True
                    if is_docstring:
                        for d in range(body[0].lineno - 1, body[0].end_lineno):
                            docstring_lines.add(d)
    except SyntaxError:
        pass

    result: list[str] = []
    for idx, line in enumerate(lines):
        if idx in docstring_lines:
            continue
        stripped = line.lstrip()
        if stripped.startswith("#"):
            if is_directive(line, "py", idx + 1):
                result.append(line)
            continue
        result.append(line)

    return "\n".join(result)


def strip_js(source: str) -> str:
    out: list[str] = []
    i = 0
    n = len(source)
    line_buf: list[str] = []

    def _flush_line_buf() -> None:
        out.extend(line_buf)
        line_buf.clear()

    while i < n:
        ch = source[i]

        if i + 1 < n and ch == "/" and source[i + 1] == "/":
            comment_start = i
            while i < n and source[i] != "\n":
                i += 1
            comment_text = source[comment_start:i]
            if is_directive(comment_text, "js"):
                _flush_line_buf()
                out.append(comment_text)
            else:
                line_content = "".join(line_buf)
                if line_content.strip() == "":
                    line_buf.clear()
                    if i < n and source[i] == "\n":
                        i += 1
                else:
                    _flush_line_buf()
            continue

        if i + 1 < n and ch == "/" and source[i + 1] == "*":
            _flush_line_buf()
            block_start = i
            i += 2
            while i < n:
                if i + 1 < n and source[i] == "*" and source[i + 1] == "/":
                    i += 2
                    break
                i += 1
            block_text = source[block_start:i]
            if is_directive(block_text, "js"):
                out.append(block_text)
            continue

        if ch == "`":
            _flush_line_buf()
            out.append(ch)
            i += 1
            while i < n:
                if source[i] == "\\":
                    out.append(source[i : i + 2])
                    i += 2
                    continue
                if source[i] == "`":
                    out.append(ch)
                    i += 1
                    break
                if source[i] == "$" and i + 1 < n and source[i + 1] == "{":
                    out.append(source[i : i + 2])
                    i += 2
                    depth = 1
                    while i < n and depth > 0:
                        if source[i] == "{":
                            depth += 1
                        elif source[i] == "}":
                            depth -= 1
                        out.append(source[i])
                        i += 1
                    continue
                out.append(source[i])
                i += 1
            continue

        if ch == '"':
            _flush_line_buf()
            out.append(ch)
            i += 1
            while i < n:
                if source[i] == "\\":
                    out.append(source[i : i + 2])
                    i += 2
                    continue
                if source[i] == '"':
                    out.append(ch)
                    i += 1
                    break
                out.append(source[i])
                i += 1
            continue

        if ch == "'":
            _flush_line_buf()
            out.append(ch)
            i += 1
            while i < n:
                if source[i] == "\\":
                    out.append(source[i : i + 2])
                    i += 2
                    continue
                if source[i] == "'":
                    out.append(ch)
                    i += 1
                    break
                out.append(source[i])
                i += 1
            continue

        if ch == "\n":
            _flush_line_buf()
            out.append(ch)
            i += 1
            continue

        line_buf.append(ch)
        i += 1

    _flush_line_buf()
    return "".join(out)


def process_file(filepath: str) -> bool:
    path = Path(filepath)
    ext = path.suffix
    if ext == ".py":
        lang = "py"
    elif ext in (".cpp", ".hpp", ".h", ".cc", ".cxx", ".c"):
        lang = "cpp"
    elif ext in (".js", ".mjs", ".cjs"):
        lang = "js"
    else:
        return False

    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return False

    if lang == "cpp":
        new_source = strip_cpp(source)
    elif lang == "py":
        new_source = strip_py(source)
    elif lang == "js":
        new_source = strip_js(source)
    else:
        return False

    if new_source != source:
        path.write_text(new_source, encoding="utf-8")
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Strip non-build-necessary comments")
    parser.add_argument("paths", nargs="*", help="Files or directories to process")
    args = parser.parse_args()

    targets = args.paths
    if not targets:
        targets = ["."]

    skip_dirs = {
        ".git",
        "__pycache__",
        "node_modules",
        "vendor",
        "build",
        "build-test",
        "build-unit",
        "dist",
        "rufh",
        ".opencode",
    }
    files: list[str] = []
    for target in targets:
        p = Path(target)
        if p.is_file():
            files.append(str(p))
        elif p.is_dir():
            for root, dirs, fnames in os.walk(target):
                dirs[:] = [d for d in dirs if d not in skip_dirs]
                for fn in fnames:
                    ext = Path(fn).suffix
                    if ext in (
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
                    ):
                        files.append(os.path.join(root, fn))

    changed = 0
    for f in sorted(files):
        if process_file(f):
            changed += 1
            print(f"  cleaned: {f}")

    print(f"Done. Cleaned {changed} files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
