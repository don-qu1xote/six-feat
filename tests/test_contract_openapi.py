from __future__ import annotations

import pytest
import schemathesis
from hypothesis import settings
from schemathesis.specs.openapi.checks import response_schema_conformance, status_code_conformance

from conftest import SERVICE_BASE

pytestmark = pytest.mark.openapi_endpoint

# [SF-YM-04] settings/yandex/playlists и settings/yandex/import
# гейтятся на «уже подключено» ДО вызова yandex-gateway (404 если не
# подключено) — в отличие от device/start|poll, которые безусловно
# обращаются к замоканому апстриму — поэтому фаззинг без личного токена
# никогда не доходит до незапрограммированного мока; безопасно.
_SIX_FEAT_NATIVE_PATHS = (
    r"^/api/v1/(graph(/path|/deepen)?|search|status|artist|api-keys(/revoke)?"
    r"|settings/providers|settings/genius-token|settings/disconnect"
    r"|settings/yandex/(playlists|import))$"
)


@pytest.fixture(scope="session")
def api_schema(service_proc):  # noqa: ARG001
    return schemathesis.openapi.from_url(f"{SERVICE_BASE}/api/v1/openapi.json")


# Фильтр путей ОБЯЗАТЕЛЬНО цепочкой на LazySchema, а не внутри фикстуры:
# LazySchema.parametrize() разрешает фикстуру per-test через get_schema(),
# который делает schema.clone(filter_set=merged_filter_set) — clone()
# полностью заменяет filter_set, и вызов .include() внутри фикстуры тихо
# отбрасывается (CI фаззил весь openapi.json, включая six-feat-game/*,
# для которых у голого тестового бинарника нет handler-ов).
schema = schemathesis.pytest.from_fixture("api_schema").include(path_regex=_SIX_FEAT_NATIVE_PATHS)


@schema.parametrize()
@settings(max_examples=8, deadline=None)
def test_matches_openapi_contract(case, auth_cookie: str):
    case.call_and_validate(
        cookies={"six_feat_session": auth_cookie},
        checks=[status_code_conformance, response_schema_conformance],
    )
