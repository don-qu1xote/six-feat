"""
test_detect_changes.py — [SF-CI-08] scripts/detect-changes.sh regression.

Pure subprocess test, no Postgres/compiled binaries needed — same "fast,
infra-free" tier as test_migrations.py/test_role_mask.py.

Regression this guards against: the workflow_dispatch branch used a bare
`return 0` to short-circuit the normal git-diff detection. CI invokes this
file as `bash scripts/detect-changes.sh HEAD~1` (executed, not sourced) —
under that invocation `return` outside a function is a hard bash error
("can only 'return' from a function or sourced script", exit code 2), so
the "Detect changes" step itself failed and every downstream job (all of
which declare `needs: detect-changes`) was skipped outright. The manual
"Run workflow" button (the entire point of this ticket) ran nothing at
all — three prior commits chased this as a pipefail/shell-selection issue
without ever exercising the actual failing branch, which is exactly why a
script-level regression test is worth having here.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "detect-changes.sh"


def _run(env_overrides: dict) -> subprocess.CompletedProcess:
    import os

    env = {**os.environ, **env_overrides}
    return subprocess.run(
        ["bash", str(SCRIPT), "HEAD~1"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


class TestWorkflowDispatch:
    def test_executed_invocation_exits_zero(self):
        """The exact invocation shape CI uses (`bash scripts/detect-changes.sh
        <ref>`, not `source`) must succeed — this is what a bare `return`
        broke."""
        result = _run({"GITHUB_EVENT_NAME": "workflow_dispatch"})
        assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"

    def test_reports_everything_affected_on_stdout(self):
        result = _run({"GITHUB_EVENT_NAME": "workflow_dispatch"})
        assert "six-feat" in result.stdout
        assert "enrichment" in result.stdout
        assert "FRONTEND: true" in result.stdout
        assert "DOCKER: true" in result.stdout

    def test_populates_github_output_with_everything(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False) as f:
            output_path = f.name
        try:
            result = _run({"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_OUTPUT": output_path})
            assert result.returncode == 0
            content = Path(output_path).read_text()
            assert "services=six-feat" in content
            assert "tests=unit integration" in content
            assert "lint=clang-tidy" in content
            assert "frontend=true" in content
            assert "docker=true" in content
        finally:
            Path(output_path).unlink(missing_ok=True)

    def test_does_not_invoke_git_diff_against_a_nonexistent_ref(self):
        """workflow_dispatch has no meaningful HEAD~1 to diff against — a
        fresh/shallow checkout might not even have that ref. Passing a
        deliberately bogus ref proves the git-diff path is skipped
        entirely, not merely tolerant of failure."""
        result = _run({"GITHUB_EVENT_NAME": "workflow_dispatch"})
        assert result.returncode == 0


class TestNormalInvocationUnaffected:
    def test_non_dispatch_event_still_exits_zero(self):
        result = _run({"GITHUB_EVENT_NAME": "push"})
        assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"

    def test_missing_event_name_behaves_like_a_normal_run(self):
        """Local/manual invocations (no GITHUB_EVENT_NAME at all) must keep
        doing real git-diff-based detection, not accidentally take the
        workflow_dispatch shortcut."""
        import os

        env = {k: v for k, v in os.environ.items() if k != "GITHUB_EVENT_NAME"}
        result = subprocess.run(
            ["bash", str(SCRIPT), "HEAD~1"],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0
        assert "workflow_dispatch" not in result.stdout


class TestSourcedInvocationStillWorks:
    def test_sourcing_the_script_does_not_kill_the_shell(self):
        """The docstring's own documented local-dev usage (`source
        scripts/detect-changes.sh`) must still work — `return` is only
        valid when sourced, `exit` only when executed; this exercises the
        sourced side of that split."""
        script = (
            f"GITHUB_EVENT_NAME=workflow_dispatch; "
            f"source {SCRIPT} HEAD~1; "
            f'echo "ALIVE=yes"; '
            f'echo "SERVICES=[$SERVICES]"'
        )
        result = subprocess.run(
            ["bash", "-c", script],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"
        assert "ALIVE=yes" in result.stdout
        assert "SERVICES=[six-feat enrichment auth game genius-gateway yandex-gateway]" in (
            result.stdout
        )


def test_script_is_syntactically_valid_bash():
    """`bash -n` catches the class of error a bare `return` in the wrong
    context does NOT (bash accepts it at parse time — it's only a runtime
    error), but it's a cheap first line of defense against outright syntax
    breakage in future edits."""
    result = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
