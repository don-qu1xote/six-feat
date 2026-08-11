"""[SF-INF-10] Локальный деплой: `make deploy-local`.

Полный прогон (`up` → health-check → smoke) требует запущенного докер-демона
и нескольких минут сборки, поэтому здесь проверяется всё, что можно проверить
без демона: разрешение профиля, preflight (рендер compose ловит недостающие
секреты), и — обязательно — что публичный туннель по умолчанию ВЫКЛЮЧЕН.
Последнее про безопасность: цена ошибки здесь — домашняя машина в интернете.

`docker compose config` демона не требует: он только подставляет переменные и
валидирует файл — то же, что делает cd_deploy.sh перед отправкой на хост.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "deploy_local.sh"
MAKEFILE = REPO_ROOT / "Makefile"
COMPOSE_FILE = REPO_ROOT / "docker-compose.yml"

MINIMAL_ENV = """ENV_PROFILE={profile}
GENIUS_CLIENT_ID=test-client-id
GENIUS_CLIENT_SECRET=test-client-secret
APP_SECRET={hex64}
DB_NAME=six_feat
DB_USER=six_feat
DB_PASSWORD=test-password
ENRICHMENT_INTERNAL_SECRET={hex64}
"""


def _has_compose() -> bool:
    if shutil.which("docker") is None:
        return False
    probe = subprocess.run(
        ["docker", "compose", "version"], capture_output=True, text=True, timeout=60
    )
    return probe.returncode == 0


requires_compose = pytest.mark.skipif(
    not _has_compose(), reason="нужен docker compose (демон не требуется — только рендер)"
)


def _env_file(tmp_path: Path, profile: str = "staging", drop: str | None = None) -> Path:
    body = MINIMAL_ENV.format(profile=profile, hex64="a" * 64)
    if drop:
        body = "".join(line for line in body.splitlines(keepends=True) if not line.startswith(drop))
    path = tmp_path / ".env.test"
    path.write_text(body)
    return path


def _run(env_file: Path, **overrides: str) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k not in ("ENV_PROFILE", "PUBLIC_TUNNEL", "CI")}
    env["ENV_FILE"] = str(env_file)
    env.update(overrides)
    return subprocess.run(
        ["bash", str(SCRIPT), "--dry-run"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


def test_script_is_valid_bash():
    check = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True, timeout=30)
    assert check.returncode == 0, check.stderr


def test_makefile_runs_the_script_without_relying_on_the_exec_bit():
    """Бит +x переживает git, но теряется при копировании файла руками.

    Тогда `make deploy-local` падает с «Permission denied» и выглядит как
    сломанный таргет, хотя дело только в режиме файла — поэтому Makefile
    зовёт скрипт через bash.
    """
    text = MAKEFILE.read_text()
    assert "deploy-local:" in text
    assert "bash ./scripts/deploy_local.sh" in text


def test_there_is_no_second_compose_file():
    """SF-CFG-02: окружения различаются профилем, а не вторым compose-файлом."""
    extra = [
        p.name
        for p in REPO_ROOT.glob("docker-compose*.y*ml")
        if p.name != COMPOSE_FILE.name and "override" not in p.name
    ]
    assert not extra, f"появился второй compose-файл: {extra}"


@requires_compose
class TestPreflight:
    def test_non_dev_profile_passes_preflight(self, tmp_path: Path):
        result = _run(_env_file(tmp_path, profile="staging"))
        assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
        assert "профиль: staging" in result.stdout

    def test_dev_profile_is_refused(self, tmp_path: Path):
        result = _run(_env_file(tmp_path, profile="dev"))
        assert result.returncode != 0
        assert "dev-профиль здесь запрещён" in result.stderr

    def test_env_var_overrides_the_env_file_profile(self, tmp_path: Path):
        result = _run(_env_file(tmp_path, profile="dev"), ENV_PROFILE="prod")
        assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
        assert "профиль: prod (переменная окружения)" in result.stdout

    def test_missing_secret_fails_before_anything_starts(self, tmp_path: Path):
        result = _run(_env_file(tmp_path, drop="APP_SECRET"))
        assert result.returncode != 0
        assert "APP_SECRET" in (result.stdout + result.stderr)

    def test_warns_that_secure_cookie_will_not_work_over_http(self, tmp_path: Path):
        result = _run(_env_file(tmp_path, profile="staging"))
        assert "COOKIE_SECURE=true" in result.stderr
        assert "http" in result.stderr


@requires_compose
class TestTunnelIsOffByDefault:
    """Дефолт туннеля — вопрос безопасности, а не удобства."""

    def test_tunnel_is_off_when_nothing_is_asked(self, tmp_path: Path):
        result = _run(_env_file(tmp_path))
        assert result.returncode == 0
        assert "туннель: off" in result.stdout

    def test_env_file_cannot_turn_the_tunnel_on(self, tmp_path: Path):

        env_file = _env_file(tmp_path)
        env_file.write_text(env_file.read_text() + "PUBLIC_TUNNEL=cloudflared\n")

        result = _run(env_file)

        assert result.returncode == 0
        assert "туннель: off" in result.stdout

    def test_tunnel_is_refused_in_ci(self, tmp_path: Path):
        result = _run(_env_file(tmp_path), PUBLIC_TUNNEL="cloudflared", CI="true")
        assert result.returncode != 0
        assert "в CI — отказ" in result.stderr

    def test_unknown_tunnel_backend_is_refused(self, tmp_path: Path):
        result = _run(_env_file(tmp_path), PUBLIC_TUNNEL="ngrok")
        assert result.returncode != 0
        assert "не поддерживается" in result.stderr

    def test_tunnel_requires_a_non_dev_profile(self, tmp_path: Path):
        result = _run(_env_file(tmp_path, profile="dev"), PUBLIC_TUNNEL="cloudflared")
        assert result.returncode != 0
        assert "dev-профиль здесь запрещён" in result.stderr


class TestSameGatesAsCd:
    """Локальный деплой обязан падать там же, где упал бы удалённый."""

    def test_reuses_the_cd_health_check_and_smoke_scripts(self):
        text = SCRIPT.read_text()
        assert "scripts/cd_health_check.py" in text
        assert "scripts/cd_smoke_test.py" in text

    def test_cd_pipeline_knows_about_the_local_target(self):
        cd = (REPO_ROOT / ".github" / "workflows" / "cd.yml").read_text()
        assert "target:" in cd
        assert "deploy-local-handoff:" in cd
        assert "needs.config.outputs.target != 'local'" in cd
