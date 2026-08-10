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
        # NOLINTBEGIN/NOLINTEND — такие же директивы clang-tidy, как NOLINT:
        # ими глушат проверку на блоке, а не на одной строке.
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
    # Отличает regex-литерал от деления по предыдущему значащему токену.
    # Без этого /can't be scored/i читается как начало строки с апострофом,
    # и всё содержимое файла после него разбирается со сбитым состоянием.
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
    # i указывает на открывающий '/'. Возвращает индекс за закрывающим '/'.
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
    return None


def is_violation(text: str, lang: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    if is_directive(stripped, lang):
        return False
    if has_cyrillic(stripped):
        return False
    return True


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


def strip_file(filepath: str) -> int:
    path = Path(filepath)
    if is_test_file(filepath):
        return 0
    ext = path.suffix
    lang = get_lang(ext)
    if lang is None:
        return 0

    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return 0

    original = source
    removed = 0

    if lang == "py":
        line_comments = extract_py_line_comments(source)
        for lineno, col, text in reversed(line_comments):
            if is_violation(text, lang):
                lines = source.split("\n")
                line_idx = lineno - 1
                if line_idx < len(lines):
                    line = lines[line_idx]
                    comment_start = line[:col]
                    lines[line_idx] = comment_start.rstrip()
                source = "\n".join(lines)
                removed += 1
    elif lang == "cpp":
        line_comments = extract_cpp_line_comments(source)
        for lineno, col, end_col, text in reversed(line_comments):
            if is_violation(text, lang):
                lines = source.split("\n")
                line_idx = lineno - 1
                if line_idx < len(lines):
                    line = lines[line_idx]
                    rel_col = col - line_start_offsets(lines)[line_idx]
                    comment_start = line[:rel_col]
                    lines[line_idx] = comment_start.rstrip()
                source = "\n".join(lines)
                removed += 1

        block_comments = extract_cpp_block_comments(source)
        for lineno, col, end_col, text in reversed(block_comments):
            if is_violation(text, lang):
                lines = source.split("\n")
                strip_block_comment(lines, line_start_offsets(lines), lineno, col, end_col, text)
                source = "\n".join(lines)
                removed += 1
    elif lang == "js":
        line_comments = extract_js_line_comments(source)
        for lineno, col, end_col, text in reversed(line_comments):
            if is_violation(text, lang):
                lines = source.split("\n")
                line_idx = lineno - 1
                if line_idx < len(lines):
                    line = lines[line_idx]
                    rel_col = col - line_start_offsets(lines)[line_idx]
                    comment_start = line[:rel_col]
                    lines[line_idx] = comment_start.rstrip()
                source = "\n".join(lines)
                removed += 1

        block_comments = extract_js_block_comments(source)
        for lineno, col, end_col, text in reversed(block_comments):
            if is_violation(text, lang):
                lines = source.split("\n")
                strip_block_comment(lines, line_start_offsets(lines), lineno, col, end_col, text)
                source = "\n".join(lines)
                removed += 1
    elif lang == "css":
        block_comments = extract_css_block_comments(source)
        for lineno, col, end_col, text in reversed(block_comments):
            if is_violation(text, lang):
                lines = source.split("\n")
                strip_block_comment(lines, line_start_offsets(lines), lineno, col, end_col, text)
                source = "\n".join(lines)
                removed += 1
    elif lang == "html":
        block_comments = extract_html_comments(source)
        for lineno, col, end_col, text in reversed(block_comments):
            if is_violation(text, lang):
                lines = source.split("\n")
                strip_block_comment(lines, line_start_offsets(lines), lineno, col, end_col, text)
                source = "\n".join(lines)
                removed += 1

    if source != original:
        path.write_text(source, encoding="utf-8")

    return removed


def check_file(filepath: str) -> list[str]:
    path = Path(filepath)
    if is_test_file(filepath):
        return []
    ext = path.suffix
    lang = get_lang(ext)
    if lang is None:
        return []

    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []

    violations: list[str] = []

    if lang == "py":
        line_comments = extract_py_line_comments(source)
        for lineno, col, text in line_comments:
            if is_violation(text, lang):
                violations.append(f"{filepath}:{lineno}: {text.strip()[:80]}")
    elif lang == "cpp":
        line_comments = extract_cpp_line_comments(source)
        for lineno, col, end_col, text in line_comments:
            if is_violation(text, lang):
                violations.append(f"{filepath}:{lineno}: {text.strip()[:80]}")
        block_comments = extract_cpp_block_comments(source)
        for lineno, col, end_col, text in block_comments:
            if is_violation(text, lang):
                violations.append(f"{filepath}:{lineno}: {text.strip()[:80]}")
    elif lang == "js":
        line_comments = extract_js_line_comments(source)
        for lineno, col, end_col, text in line_comments:
            if is_violation(text, lang):
                violations.append(f"{filepath}:{lineno}: {text.strip()[:80]}")
        block_comments = extract_js_block_comments(source)
        for lineno, col, end_col, text in block_comments:
            if is_violation(text, lang):
                violations.append(f"{filepath}:{lineno}: {text.strip()[:80]}")
    elif lang == "css":
        block_comments = extract_css_block_comments(source)
        for lineno, col, end_col, text in block_comments:
            if is_violation(text, lang):
                violations.append(f"{filepath}:{lineno}: {text.strip()[:80]}")
    elif lang == "html":
        block_comments = extract_html_comments(source)
        for lineno, col, end_col, text in block_comments:
            if is_violation(text, lang):
                violations.append(f"{filepath}:{lineno}: {text.strip()[:80]}")

    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description="Check or strip non-build, non-Russian comments")
    parser.add_argument("paths", nargs="*", help="Files or directories to check")
    parser.add_argument("--fix", action="store_true", help="Remove non-build, non-Russian comments")
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
                        # Отчёт покрытия — сгенерированный HTML с чужими
                        # английскими комментариями внутри; в git его нет,
                        # но локально он лежит рядом и ронял проверку.
                        "coverage",
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
                        ".css",
                        ".html",
                    ):
                        files.append(os.path.join(root, fn))

    if args.fix:
        total_removed = 0
        analyzed = 0
        for f in sorted(files):
            analyzed += 1
            if analyzed % 50 == 1 or analyzed == len(files):
                print(f"check_comments: fixing {f} ({analyzed}/{len(files)})", file=sys.stderr)
            removed = strip_file(f)
            total_removed += removed
        print(
            f"check_comments: removed {total_removed} non-build/non-Russian comments from {analyzed} files",
            file=sys.stderr,
        )
        return 0

    all_violations: list[str] = []
    analyzed = 0
    for f in sorted(files):
        analyzed += 1
        if analyzed % 50 == 1 or analyzed == len(files):
            print(f"check_comments: analyzing {f} ({analyzed}/{len(files)})", file=sys.stderr)
        all_violations.extend(check_file(f))

    print(f"check_comments: analyzed {analyzed} files", file=sys.stderr)

    if all_violations:
        print(f"Found {len(all_violations)} comment violations (non-build, non-Russian):")
        for v in all_violations:
            print(v)
        return 1

    print("All comments are build-necessary or in Russian.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
