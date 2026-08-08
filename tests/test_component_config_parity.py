from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

SRC_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(SRC_ROOT / "scripts"))

MAIN_CPP = SRC_ROOT / "services" / "six-feat" / "src" / "main.cpp"
STATIC_CONFIG = SRC_ROOT / "services" / "six-feat" / "static_config.yaml"
# Хендлеры six-feat живут и в самом сервисе, и в общих библиотеках
# (health_handler в six-feat-http и т.п.) — искать kName надо в обоих местах.
HEADER_DIRS = (SRC_ROOT / "services" / "six-feat" / "src", SRC_ROOT / "libs")

# Готовые компоненты userver, у которых нет нашего заголовка с kName, но секция
# в конфиге обязана быть.
FRAMEWORK_HANDLERS = {"handler-server-monitor"}

_APPEND_RE = re.compile(r"\.Append<\s*([A-Za-z_][A-Za-z0-9_:]*)\s*>\(\)")
_CLASS_BODY_RE = re.compile(r"class\s+(\w+)\s+final\s*:[^{]*\{(.*?)^\};", re.S | re.M)
_KNAME_RE = re.compile(r'kName\s*=\s*"(handler-[a-z0-9-]+)"')
_HANDLER_KEY_RE = re.compile(r"^\s{4}(handler-[a-z0-9-]+):", re.M)


def _handler_keys(text: str) -> set[str]:
    return set(_HANDLER_KEY_RE.findall(text))


def _registered_handler_names() -> set[str]:
    class_to_name: dict[str, str] = {}
    for header_dir in HEADER_DIRS:
        for header in header_dir.rglob("*.hpp"):
            for cls, body in _CLASS_BODY_RE.findall(header.read_text()):
                found = _KNAME_RE.search(body)
                if found:
                    class_to_name[cls] = found.group(1)

    appended = [m.split("::")[-1] for m in _APPEND_RE.findall(MAIN_CPP.read_text())]
    return {class_to_name[cls] for cls in appended if cls in class_to_name} | FRAMEWORK_HANDLERS


def _prod_handlers() -> set[str]:
    return _handler_keys(STATIC_CONFIG.read_text())


def _conftest_template() -> str:
    import conftest

    return conftest._TEST_CONFIG_TEMPLATE


def _e2e_template() -> str:
    import e2e_env

    return e2e_env._STATIC_CONFIG_TEMPLATE


# Расхождение между списком компонентов в main.cpp и конфигом роняет сервис на
# старте целиком, а не на конкретном запросе: userver проверяет обе стороны —
# и компонент без секции конфига, и секцию конфига без компонента. До этого
# теста такое расхождение всплывало только через 40 минут в интеграционных
# джобах, в виде «сервис не поднялся за таймаут», без настоящей причины.
class TestRegisteredComponentsMatchProdConfig:
    def test_every_registered_handler_has_a_prod_config_section(self):
        missing = _registered_handler_names() - _prod_handlers()
        assert not missing, (
            "зарегистрированы в main.cpp, но нет секции в static_config.yaml "
            f"(сервис не стартует): {sorted(missing)}"
        )

    def test_every_prod_config_section_has_a_registered_component(self):
        orphans = _prod_handlers() - _registered_handler_names()
        assert not orphans, (
            "есть в static_config.yaml, но компонент не зарегистрирован в main.cpp "
            f"(сервис не стартует): {sorted(orphans)}"
        )


# Шаблоны конфигов для тестов — отдельные копии продового static_config.yaml, и
# они разъезжаются молча: хендлер добавили в прод, а в шаблон забыли (или
# наоборот — удалили из прода, а в шаблоне остался).
@pytest.mark.parametrize(
    "name,loader",
    [
        ("tests/conftest.py", _conftest_template),
        ("scripts/e2e_env.py", _e2e_template),
    ],
)
class TestTestConfigTemplatesMatchProdConfig:
    def test_template_covers_every_prod_handler(self, name, loader):
        missing = _prod_handlers() - _handler_keys(loader())
        assert not missing, (
            f"{name}: в шаблоне конфига six-feat нет хендлеров, которые "
            f"регистрирует main.cpp (сервис под тестом не стартует): {sorted(missing)}"
        )

    def test_template_has_no_handler_that_prod_dropped(self, name, loader):
        stale = _handler_keys(loader()) - _prod_handlers()
        assert not stale, (
            f"{name}: в шаблоне остались хендлеры, которых больше нет в проде "
            f"(сервис под тестом не стартует): {sorted(stale)}"
        )
