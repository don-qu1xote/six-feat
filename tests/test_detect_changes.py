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
        result = _run({"GITHUB_EVENT_NAME": "workflow_dispatch"})
        assert result.returncode == 0


class TestNormalInvocationUnaffected:
    def test_non_dispatch_event_still_exits_zero(self):
        result = _run({"GITHUB_EVENT_NAME": "push"})
        assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"

    def test_missing_event_name_behaves_like_a_normal_run(self):
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
        assert "SERVICES=[six-feat enrichment auth game genius-gateway]" in (result.stdout)


def test_script_is_syntactically_valid_bash():
    result = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
