#!/usr/bin/env python3
import argparse
import ast
import os
import re
import sys
import tokenize
from pathlib import Path

CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")

DIRECTIVE_PATTERNS = {
    "cpp": [
        re.compile(r"^\s*//\s*NOLINT(?:NEXTLINE)?\b"),
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


def extract_cpp_comments(source: str) -> list[tuple[int, str]]:
    results: list[tuple[int, str]] = []
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
    block_text = ""

    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""

        if in_block_comment:
            if ch == "*" and nxt == "/":
                block_text += "*/"
                results.append((block_start_line, block_text))
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

        if ch == "/" and nxt == "/":
            rest = source[i + 2 :]
            results.append((line, "//" + rest))
            i = n
            continue

        if ch == "/" and nxt == "*":
            in_block_comment = True
            block_start_line = line
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


def extract_py_comments(source: str) -> list[tuple[int, str]]:
    results: list[tuple[int, str]] = []
    try:
        tokens = tokenize.generate_tokens(iter(source.splitlines(keepends=True)).__next__)
    except tokenize.TokenError:
        return results

    for tok in tokens:
        if tok.type == tokenize.COMMENT:
            results.append((tok.start[0], tok.string))
        elif tok.type == tokenize.STRING and tok.start[0] == tok.end[0]:
            pass
    return results


def extract_py_docstrings(source: str) -> list[tuple[int, str]]:
    results: list[tuple[int, str]] = []
    try:
        tree = compile(source, "<string>", "exec", ast.PyCF_ONLY_AST)
    except SyntaxError:
        return results

    def _is_docstring(node):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)):
            return False
        body = node.body
        return (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        )

    for node in ast.walk(tree):
        if _is_docstring(node):
            expr = node.body[0]
            val = expr.value.value
            results.append((expr.lineno, '"""' + val + '"""'))

    return results


def extract_js_comments(source: str) -> list[tuple[int, str]]:
    results: list[tuple[int, str]] = []
    i = 0
    n = len(source)
    line = 1
    in_string = False
    string_char = ""
    in_template = False
    template_depth = 0
    in_block_comment = False
    block_start_line = 0
    block_text = ""
    in_regex = False

    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""

        if in_block_comment:
            if ch == "*" and nxt == "/":
                block_text += "*/"
                results.append((block_start_line, block_text))
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

        if ch == "/" and nxt == "/":
            rest = source[i + 2 :]
            results.append((line, "//" + rest))
            i = n
            continue

        if ch == "/" and nxt == "*":
            in_block_comment = True
            block_start_line = line
            block_text = "/*"
            i += 2
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


def is_test_file(filepath: str) -> bool:
    p = Path(filepath)
    if "tests" in p.parts or "test" in p.parts:
        return True
    name = p.name
    if (
        name.startswith("test_")
        or name.endswith("_test.py")
        or name.endswith(".test.js")
        or name.endswith(".spec.js")
        or name.endswith(".config.js")
        or name.endswith(".config.mjs")
        or name in ("global-setup.js", "setup.js")
    ):
        return True
    return False


def check_file(filepath: str) -> list[str]:
    path = Path(filepath)
    if is_test_file(filepath):
        return []
    ext = path.suffix
    if ext == ".py":
        lang = "py"
    elif ext in (".cpp", ".hpp", ".h", ".cc", ".cxx", ".c"):
        lang = "cpp"
    elif ext in (".js", ".mjs", ".cjs"):
        lang = "js"
    else:
        return []

    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []

    violations: list[str] = []

    if lang == "py":
        line_comments = extract_py_comments(source)
        docstrings = extract_py_docstrings(source)
        all_comments = line_comments + docstrings
    elif lang == "cpp":
        all_comments = extract_cpp_comments(source)
    elif lang == "js":
        all_comments = extract_js_comments(source)
    else:
        return []

    for lineno, text in all_comments:
        stripped = text.strip()
        if not stripped:
            continue
        if is_directive(stripped, lang):
            continue
        if has_cyrillic(stripped):
            continue
        violations.append(f"{filepath}:{lineno}: {stripped[:80]}")

    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description="Check comments are build-necessary and Russian")
    parser.add_argument("paths", nargs="*", help="Files or directories to check")
    args = parser.parse_args()

    targets = args.paths
    if not targets:
        targets = ["."]

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
                    if d
                    not in {
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
                ]
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

    all_violations: list[str] = []
    for f in sorted(files):
        all_violations.extend(check_file(f))

    if all_violations:
        print(f"Found {len(all_violations)} comment violations (non-build, non-Russian):")
        for v in all_violations:
            print(v)
        return 1

    print("All comments are build-necessary or in Russian.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
