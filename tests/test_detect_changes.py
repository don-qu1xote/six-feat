from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "detect-changes.sh"


def _run(env_overrides: dict, cwd: Path = REPO_ROOT) -> subprocess.CompletedProcess:

    env = {k: v for k, v in os.environ.items() if k != "FORCE_ALL"}
    env.update(env_overrides)
    return subprocess.run(
        ["bash", str(SCRIPT), "HEAD~1"],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


@pytest.fixture
def docs_only_repo(tmp_path: Path) -> Path:
    """Репозиторий, последний коммит которого трогает только docs/.

    Форсирование надо проверять на диффе, который САМ по себе ничего не
    затрагивает, — иначе «полный набор» не отличить от обычного результата
    (в самом six-feat последний коммит почти всегда задевает и код, и тесты).
    """
    repo = tmp_path / "repo"
    (repo / "docs").mkdir(parents=True)

    def git(*args: str) -> None:
        subprocess.run(("git", *args), cwd=repo, check=True, capture_output=True)

    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")
    (repo / "README.md").write_text("seed\n")
    git("add", "-A")
    git("commit", "-qm", "seed")
    (repo / "docs" / "note.md").write_text("только документация\n")
    git("add", "-A")
    git("commit", "-qm", "docs only")
    return repo


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


def _areas(stdout: str) -> dict[str, str]:
    """Хвост вывода скрипта («SERVICES: …», «TESTS: …», …) как словарь."""
    out = {}
    for line in stdout.splitlines():
        for key in ("SERVICES", "TESTS", "LINT", "FRONTEND", "DOCKER"):
            if line.startswith(f"{key}: "):
                out[key] = line[len(key) + 2 :].strip()
    return out


class TestForceAll:
    """[SF-CI-11] Галочка force_all в workflow_dispatch."""

    def test_force_all_gives_the_full_set_regardless_of_the_diff(self, docs_only_repo: Path):
        result = _run({"GITHUB_EVENT_NAME": "push", "FORCE_ALL": "true"}, cwd=docs_only_repo)
        assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"

        areas = _areas(result.stdout)
        assert set(areas["SERVICES"].split()) == {
            "six-feat",
            "enrichment",
            "auth",
            "game",
            "genius-gateway",
        }
        assert set(areas["TESTS"].split()) == {
            "unit",
            "integration",
            "six-feat",
            "auth",
            "genius-gateway",
            "enrichment",
            "bg-resilience",
            "health",
        }
        assert set(areas["LINT"].split()) == {
            "clang-tidy",
            "eslint",
            "format",
            "yaml",
            "promtool",
        }
        assert areas["FRONTEND"] == "true"
        assert areas["DOCKER"] == "true"

    def test_force_all_works_on_a_push_not_only_on_a_manual_run(self, docs_only_repo: Path):

        forced = _run({"GITHUB_EVENT_NAME": "push", "FORCE_ALL": "true"}, cwd=docs_only_repo)
        dispatched = _run({"GITHUB_EVENT_NAME": "workflow_dispatch"}, cwd=docs_only_repo)

        assert _areas(forced.stdout) == _areas(dispatched.stdout)

    def test_force_all_fills_github_output_with_everything(self, docs_only_repo: Path):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False) as f:
            output_path = f.name
        try:
            result = _run(
                {"GITHUB_EVENT_NAME": "push", "FORCE_ALL": "true", "GITHUB_OUTPUT": output_path},
                cwd=docs_only_repo,
            )
            assert result.returncode == 0
            content = Path(output_path).read_text()
            assert "services=six-feat enrichment auth game genius-gateway" in content
            assert "tests=unit integration" in content
            assert "lint=clang-tidy" in content
            assert "frontend=true" in content
            assert "docker=true" in content
        finally:
            Path(output_path).unlink(missing_ok=True)


class TestWithoutTheFlagNothingChanged:
    """Регресс: без флага дифф разбирается ровно как раньше."""

    def test_docs_only_change_stays_narrow(self, docs_only_repo: Path):
        result = _run({"GITHUB_EVENT_NAME": "push"}, cwd=docs_only_repo)
        assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"

        areas = _areas(result.stdout)
        assert areas["SERVICES"] == ""
        assert areas["TESTS"] == ""
        assert areas["LINT"] == ""
        assert areas["FRONTEND"] == "false"
        assert areas["DOCKER"] == "false"

    def test_force_all_false_is_indistinguishable_from_no_flag(self, docs_only_repo: Path):
        without = _run({"GITHUB_EVENT_NAME": "push"}, cwd=docs_only_repo)
        explicit_false = _run(
            {"GITHUB_EVENT_NAME": "push", "FORCE_ALL": "false"}, cwd=docs_only_repo
        )

        assert without.stdout == explicit_false.stdout

    def test_unchecked_checkbox_arrives_as_an_empty_string(self, docs_only_repo: Path):

        result = _run({"GITHUB_EVENT_NAME": "push", "FORCE_ALL": ""}, cwd=docs_only_repo)

        assert _areas(result.stdout)["FRONTEND"] == "false"
        assert _areas(result.stdout)["DOCKER"] == "false"
