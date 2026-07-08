#!/usr/bin/env bash
#
# restructure.sh — перекроить файловую структуру six-feat под доменное
# деление, как принято в больших проектах.
#
# ЧТО ДЕЛАЕТ (в этом порядке):
#   1. src/ (C++)         → раскладывает 52 плоских файла по доменам:
#                            domain/ genius/ storage/ enrichment/ http/ core/
#                            (auth/ уже был выделен — не трогаем состав)
#   2. front/src/ (JS)    → раскладывает 8 плоских top-level файлов:
#                            api/ (net,api,auth,analytics-client)
#                            state/ (state,helpers)
#                            dom/ (dom,canvas-decorator,transition)
#                            graph.js и main.js остаются в корне front/src/
#                            (ui/ и vis-adapter/ не трогаем — уже разложены)
#   3. Конфиги            → static_config.yaml, config_vars.yaml → config/
#                            (pytest.ini, requirements-test.txt,
#                             pre-commit-config.yaml остаются в корне —
#                             pytest ищет pytest.ini автодискавери)
#   4. Переписывает пути:
#        - #include "..."  во всех .cpp/.hpp (src/, services/*)
#        - import ... from './...' во всех .js (front/src/), включая
#          обратные ссылки из переехавших файлов на НЕ переехавшие
#          (graph.js, main.js, ui/, vis-adapter/) — им тоже нужен "../",
#          т.к. переехавший файл теперь на один уровень глубже. Также
#          правит vi.mock("./x.js", ...) — vitest резолвит эти строки как
#          обычные module-специфайеры, ломаются точно так же, как import.
#        - CMakeLists.txt (корневой + 3 сервисных) — списки исходников
#        - Dockerfile — COPY static_config.yaml → COPY config/static_config.yaml
#        - CMakeLists.txt (корневой) — install(FILES static_config.yaml ...)
#   5. (бонус) Правит текстовые упоминания старых src/xxx.cpp путей внутри
#      комментариев/докстрингов (README не трогаем, но DEVELOPMENT.md,
#      docker-compose.yml, docker-entrypoint.sh, tests/*.py — да) — это не
#      влияет на выполнение, только на читаемость документации.
#
# Важно: services/*/static_config.yaml — это ОТДЕЛЬНЫЕ файлы, лежащие
# внутри каждого services/<name>/, они НЕ переезжают и их собственные
# install(FILES static_config.yaml ...) в services/*/CMakeLists.txt не
# трогаются. Переезжает только корневой static_config.yaml (для six_feat).
#
# Все перемещения делаются через `git mv`, чтобы сохранить историю файлов.
#
# Запуск: из корня репозитория ./restructure.sh
# Требует чистого git-дерева (без незакоммиченных изменений) — иначе
# откатить в случае ошибки будет сложнее.

set -euo pipefail

if [[ ! -d ".git" ]]; then
  echo "Ошибка: .git не найден. Запусти из корня репозитория." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain=v1 --untracked-files=no)" ]]; then
  echo "Ошибка: в рабочем дереве есть незакоммиченные изменения отслеживаемых файлов." >&2
  echo "Закоммить или застэшь их перед запуском — так безопаснее откатывать." >&2
  git status --short
  exit 1
fi

echo "════════════════════════════════════════════════════════════════"
echo " Перекрой файловой структуры six-feat"
echo "════════════════════════════════════════════════════════════════"
echo

# ─────────────────────────────────────────────────────────────────────────
# ШАГ 1: src/ — раскладка по доменам
# ─────────────────────────────────────────────────────────────────────────
echo "── Шаг 1/7: src/ по доменам ──"

declare -A SRC_MAP=(
  # domain/
  [src/domain_types.hpp]=src/domain/domain_types.hpp
  [src/role_mask.hpp]=src/domain/role_mask.hpp
  [src/role_mask.cpp]=src/domain/role_mask.cpp

  # genius/
  [src/genius_gateway.hpp]=src/genius/genius_gateway.hpp
  [src/genius_gateway.cpp]=src/genius/genius_gateway.cpp
  [src/genius_gateway_client.hpp]=src/genius/genius_gateway_client.hpp
  [src/genius_gateway_client.cpp]=src/genius/genius_gateway_client.cpp
  [src/genius_error_mapping.hpp]=src/genius/genius_error_mapping.hpp
  [src/genius_error_mapping.cpp]=src/genius/genius_error_mapping.cpp

  # storage/
  [src/persistent_store.hpp]=src/storage/persistent_store.hpp
  [src/persistent_store.cpp]=src/storage/persistent_store.cpp
  [src/artist_repository.hpp]=src/storage/artist_repository.hpp
  [src/artist_repository.cpp]=src/storage/artist_repository.cpp
  [src/analytics.hpp]=src/storage/analytics.hpp
  [src/analytics.cpp]=src/storage/analytics.cpp

  # enrichment/
  [src/enrichment_queue.hpp]=src/enrichment/enrichment_queue.hpp
  [src/enrichment_queue.cpp]=src/enrichment/enrichment_queue.cpp
  [src/enrichment_worker.hpp]=src/enrichment/enrichment_worker.hpp
  [src/enrichment_worker.cpp]=src/enrichment/enrichment_worker.cpp
  [src/enrichment_client.hpp]=src/enrichment/enrichment_client.hpp
  [src/enrichment_client.cpp]=src/enrichment/enrichment_client.cpp

  # http/
  [src/graph_handler.hpp]=src/http/graph_handler.hpp
  [src/graph_handler.cpp]=src/http/graph_handler.cpp
  [src/path_handler.hpp]=src/http/path_handler.hpp
  [src/path_handler.cpp]=src/http/path_handler.cpp
  [src/search_handler.hpp]=src/http/search_handler.hpp
  [src/search_handler.cpp]=src/http/search_handler.cpp
  [src/health_handler.hpp]=src/http/health_handler.hpp
  [src/health_handler.cpp]=src/http/health_handler.cpp
  [src/readiness_handler.hpp]=src/http/readiness_handler.hpp
  [src/readiness_handler.cpp]=src/http/readiness_handler.cpp
  [src/status_handler.hpp]=src/http/status_handler.hpp
  [src/status_handler.cpp]=src/http/status_handler.cpp
  [src/static_handler.hpp]=src/http/static_handler.hpp
  [src/static_handler.cpp]=src/http/static_handler.cpp
  [src/sse_status_handler.hpp]=src/http/sse_status_handler.hpp
  [src/sse_status_handler.cpp]=src/http/sse_status_handler.cpp

  # core/
  [src/resilience.hpp]=src/core/resilience.hpp
  [src/resilience.cpp]=src/core/resilience.cpp
  [src/rate_limiter.hpp]=src/core/rate_limiter.hpp
  [src/request_id.hpp]=src/core/request_id.hpp
  [src/request_id.cpp]=src/core/request_id.cpp
  [src/security_headers.hpp]=src/core/security_headers.hpp
  [src/security_headers.cpp]=src/core/security_headers.cpp
  [src/internal_auth.hpp]=src/core/internal_auth.hpp
  [src/internal_auth.cpp]=src/core/internal_auth.cpp
  [src/collab_service.hpp]=src/core/collab_service.hpp
  [src/collab_service.cpp]=src/core/collab_service.cpp
  # internal_http.{hpp,cpp} не было в исходном черновике — репозиторий разошёлся
  # со снимком, на основе которого он писался. Это общий HTTP-транспорт для
  # внутренних клиентов (EnrichmentClient, GeniusGatewayClient), который сам
  # включает internal_auth.hpp и request_id.hpp — оба уже в core/. По той же
  # логике графа #include-зависимостей кладём его туда же.
  [src/internal_http.hpp]=src/core/internal_http.hpp
  [src/internal_http.cpp]=src/core/internal_http.cpp
)

mkdir -p src/domain src/genius src/storage src/enrichment src/http src/core

for old in "${!SRC_MAP[@]}"; do
  new="${SRC_MAP[$old]}"
  if [[ -f "$old" ]]; then
    git mv "$old" "$new"
    echo "  [mv] $old -> $new"
  else
    echo "  [skip] $old не найден (уже перемещён?)"
  fi
done

# ─────────────────────────────────────────────────────────────────────────
# ШАГ 2: front/src/ — раскладка по слоям
# ─────────────────────────────────────────────────────────────────────────
echo
echo "── Шаг 2/7: front/src/ по слоям ──"

declare -A FRONT_MAP=(
  [front/src/net.js]=front/src/api/net.js
  [front/src/api.js]=front/src/api/api.js
  [front/src/auth.js]=front/src/api/auth.js
  [front/src/analytics-client.js]=front/src/api/analytics-client.js
  [front/src/analytics-client.test.js]=front/src/api/analytics-client.test.js
  [front/src/api.test.js]=front/src/api/api.test.js

  [front/src/state.js]=front/src/state/state.js
  [front/src/state.test.js]=front/src/state/state.test.js
  [front/src/helpers.js]=front/src/state/helpers.js
  [front/src/helpers.test.js]=front/src/state/helpers.test.js

  [front/src/dom.js]=front/src/dom/dom.js
  [front/src/canvas-decorator.js]=front/src/dom/canvas-decorator.js
  [front/src/transition.js]=front/src/dom/transition.js
)

mkdir -p front/src/api front/src/state front/src/dom

for old in "${!FRONT_MAP[@]}"; do
  new="${FRONT_MAP[$old]}"
  if [[ -f "$old" ]]; then
    git mv "$old" "$new"
    echo "  [mv] $old -> $new"
  else
    echo "  [skip] $old не найден (уже перемещён?)"
  fi
done

# ─────────────────────────────────────────────────────────────────────────
# ШАГ 3: конфиги в корне → config/
# ─────────────────────────────────────────────────────────────────────────
echo
echo "── Шаг 3/7: конфиги -> config/ ──"

mkdir -p config
for f in static_config.yaml config_vars.yaml; do
  if [[ -f "$f" ]]; then
    git mv "$f" "config/$f"
    echo "  [mv] $f -> config/$f"
  else
    echo "  [skip] $f не найден"
  fi
done

# ─────────────────────────────────────────────────────────────────────────
# ШАГ 4: переписать #include в C++ (src/, services/*)
# ─────────────────────────────────────────────────────────────────────────
echo
echo "── Шаг 4/7: переписываю #include в .cpp/.hpp ──"

declare -A HEADER_NEW_PATH=(
  [domain_types.hpp]=domain/domain_types.hpp
  [role_mask.hpp]=domain/role_mask.hpp
  [genius_gateway.hpp]=genius/genius_gateway.hpp
  [genius_gateway_client.hpp]=genius/genius_gateway_client.hpp
  [genius_error_mapping.hpp]=genius/genius_error_mapping.hpp
  [persistent_store.hpp]=storage/persistent_store.hpp
  [artist_repository.hpp]=storage/artist_repository.hpp
  [analytics.hpp]=storage/analytics.hpp
  [enrichment_queue.hpp]=enrichment/enrichment_queue.hpp
  [enrichment_worker.hpp]=enrichment/enrichment_worker.hpp
  [enrichment_client.hpp]=enrichment/enrichment_client.hpp
  [graph_handler.hpp]=http/graph_handler.hpp
  [path_handler.hpp]=http/path_handler.hpp
  [search_handler.hpp]=http/search_handler.hpp
  [health_handler.hpp]=http/health_handler.hpp
  [readiness_handler.hpp]=http/readiness_handler.hpp
  [status_handler.hpp]=http/status_handler.hpp
  [static_handler.hpp]=http/static_handler.hpp
  [sse_status_handler.hpp]=http/sse_status_handler.hpp
  [resilience.hpp]=core/resilience.hpp
  [rate_limiter.hpp]=core/rate_limiter.hpp
  [request_id.hpp]=core/request_id.hpp
  [security_headers.hpp]=core/security_headers.hpp
  [internal_auth.hpp]=core/internal_auth.hpp
  [collab_service.hpp]=core/collab_service.hpp
  [internal_http.hpp]=core/internal_http.hpp
)

mapfile -t CPP_FILES < <(find src services -type f \( -name '*.cpp' -o -name '*.hpp' \) 2>/dev/null)

for file in "${CPP_FILES[@]}"; do
  for old_name in "${!HEADER_NEW_PATH[@]}"; do
    new_path="${HEADER_NEW_PATH[$old_name]}"
    if grep -q "#include \"${old_name}\"" "$file" 2>/dev/null; then
      sed -i "s|#include \"${old_name}\"|#include \"${new_path}\"|g" "$file"
    fi
  done
done
echo "  [ok] #include пути обновлены в ${#CPP_FILES[@]} файлах (src/, services/*)"

# ─────────────────────────────────────────────────────────────────────────
# ШАГ 5: переписать import в JS (front/src/)
# ─────────────────────────────────────────────────────────────────────────
echo
echo "── Шаг 5/7: переписываю import в .js (front/src/) ──"

# Правим не только `import ... from "./x.js"` / `export ... from "./x.js"`,
# но и `vi.mock("./x.js", ...)` — vitest резолвит эти строки как обычные
# module-специфайеры относительно тестового файла, так что при переезде
# тестового файла (или замоканного модуля) они ломаются точно так же, как
# обычный import. Поэтому ниже подменяется сам кавыченый литерал "./x.js" /
# '../x.js', а не только конструкция после `from` — единственные места, где
# в front/src/ вообще встречаются такие литералы, это import/export/vi.mock
# (проверено grep'ом по всему дереву, в комментариях таких точных совпадений
# нет).

declare -A JS_NEW_PATH=(
  [net.js]=api/net.js
  [api.js]=api/api.js
  [auth.js]=api/auth.js
  [analytics-client.js]=api/analytics-client.js
  [state.js]=state/state.js
  [helpers.js]=state/helpers.js
  [dom.js]=dom/dom.js
  [canvas-decorator.js]=dom/canvas-decorator.js
  [transition.js]=dom/transition.js
)

# Файлы НЕПОСРЕДСТВЕННО в front/src/ (graph.js, main.js, graph.test.js):
# "./net.js" -> "./api/net.js"
for file in front/src/*.js; do
  [[ -f "$file" ]] || continue
  for old_name in "${!JS_NEW_PATH[@]}"; do
    new_path="${JS_NEW_PATH[$old_name]}"
    sed -i "s|\"\./${old_name}\"|\"./${new_path}\"|g; s|'\./${old_name}'|'./${new_path}'|g" "$file"
  done
done

# Файлы в front/src/api|state|dom/: соседи в той же папке остаются "./x.js",
# файлы в ДРУГОЙ новой папке становятся "../other/x.js"
for subdir in api state dom; do
  for file in front/src/"$subdir"/*.js; do
    [[ -f "$file" ]] || continue
    for old_name in "${!JS_NEW_PATH[@]}"; do
      new_path="${JS_NEW_PATH[$old_name]}"
      new_dir="${new_path%%/*}"
      if [[ "$new_dir" == "$subdir" ]]; then
        continue
      fi
      sed -i "s|\"\./${old_name}\"|\"../${new_path}\"|g; s|'\./${old_name}'|'../${new_path}'|g" "$file"
    done

    # Эти файлы переехали на один уровень глубже (front/src/X.js ->
    # front/src/$subdir/X.js), поэтому ссылки на то, что НЕ переехало —
    # graph.js/main.js в корне front/src/, и уже разложенные ui/ и
    # vis-adapter/ — тоже требуют добавленного "../". Цикл выше это не
    # ловит, потому что graph.js/main.js/ui/*/vis-adapter/* отсутствуют в
    # JS_NEW_PATH (они никуда не переезжают сами по себе).
    for stay in graph.js main.js; do
      sed -i "s|\"\./${stay}\"|\"../${stay}\"|g; s|'\./${stay}'|'../${stay}'|g" "$file"
    done
    for staydir in ui vis-adapter; do
      sed -i "s|\"\./${staydir}/|\"../${staydir}/|g; s|'\./${staydir}/|'../${staydir}/|g" "$file"
    done
  done
done

# front/src/ui/*.js и front/src/vis-adapter/*.js: "../name.js" -> "../new/path.js"
for dir in front/src/ui front/src/vis-adapter; do
  for file in "$dir"/*.js; do
    [[ -f "$file" ]] || continue
    for old_name in "${!JS_NEW_PATH[@]}"; do
      new_path="${JS_NEW_PATH[$old_name]}"
      sed -i "s|\"\.\./${old_name}\"|\"../${new_path}\"|g; s|'\.\./${old_name}'|'../${new_path}'|g" "$file"
    done
  done
done

echo "  [ok] import/vi.mock пути обновлены в front/src/ (top-level, api/, state/, dom/, ui/, vis-adapter/)"

# ─────────────────────────────────────────────────────────────────────────
# ШАГ 6: CMakeLists.txt, Dockerfile — пути к перемещённым файлам
# ─────────────────────────────────────────────────────────────────────────
echo
echo "── Шаг 6/7: CMakeLists.txt / Dockerfile ──"

# Корневой + сервисные CMakeLists.txt: пути к src/*.cpp.
# services/*/install(FILES static_config.yaml ...) НЕ трогаем — те файлы
# лежат в services/<name>/ и никуда не переезжали.
for cmake_file in CMakeLists.txt services/auth/CMakeLists.txt services/enrichment/CMakeLists.txt services/genius-gateway/CMakeLists.txt; do
  [[ -f "$cmake_file" ]] || continue
  for old in "${!SRC_MAP[@]}"; do
    new="${SRC_MAP[$old]}"
    sed -i "s|${old}|${new}|g" "$cmake_file"
  done
done
sed -i "s|install(FILES static_config.yaml|install(FILES config/static_config.yaml|" CMakeLists.txt
echo "  [ok] CMakeLists.txt (корень + 3 сервисных) обновлены (пути исходников); install FILES поправлен только в корневом"

# Dockerfile: COPY static_config.yaml ./ (из репозитория) -> COPY config/static_config.yaml ./config/static_config.yaml
# Строки вида "COPY --from=builder /install/etc/.../static_config.yaml ./static_config.yaml"
# копируют уже установленный cmake --install файл из билд-стейджа — не трогаем.
#
# Важно: COPY <src> <dst> в Docker, когда <dst> оканчивается на "/", кладёт
# файл ВНУТРЬ этой директории под его собственным basename — структура
# каталогов источника не воссоздаётся. Подмены одного только <src> ("COPY
# config/static_config.yaml ./") недостаточно: файл окажется на
# /src/static_config.yaml, а не на /src/config/static_config.yaml, которого
# теперь ждёт install(FILES config/static_config.yaml ...) из CMakeLists.txt
# (путь там резолвится относительно CMAKE_CURRENT_SOURCE_DIR = /src). Поэтому
# <dst> тоже нужно переписать, сохранив "config/" в целевом пути.
if [[ -f Dockerfile ]]; then
  sed -i "s|^COPY static_config\.yaml \./\$|COPY config/static_config.yaml ./config/static_config.yaml|" Dockerfile
  echo "  [ok] Dockerfile обновлён (COPY static_config.yaml ./ -> COPY config/static_config.yaml ./config/static_config.yaml)"
fi

# ─────────────────────────────────────────────────────────────────────────
# ШАГ 7 (бонус): поправить текстовые упоминания старых src/xxx.cpp путей
# в комментариях/докстрингах — DEVELOPMENT.md, docker-compose.yml,
# docker-entrypoint.sh, tests/*.py. Не влияет на выполнение кода (пути
# внутри комментариев ни на что не ссылаются программно), только на
# читаемость документации.
# ─────────────────────────────────────────────────────────────────────────
echo
echo "── Шаг 7/7 (бонус): текстовые упоминания старых src/-путей в комментариях/доках ──"

# Регулярка для поиска строится из ключей SRC_MAP (а не отдельного
# hand-maintained списка), чтобы не расходиться с ним — SRC_MAP уже содержит
# ПОЛНЫЕ пары путей для обоих расширений (.cpp И .hpp), в отличие от
# HEADER_NEW_PATH, где ключи — только голые имена .hpp-файлов (он нужен для
# переписывания #include, которые почти всегда на .hpp). Подстановка ниже
# тоже использует SRC_MAP напрямую: большинство упоминаний в докстрингах —
# это ссылки на src/xxx.cpp, а не src/xxx.hpp, и HEADER_NEW_PATH их просто
# не ловит.
mapfile -t SRC_BASENAMES < <(for old in "${!SRC_MAP[@]}"; do basename "$old"; done | sed -E 's/\.(cpp|hpp)$//' | sort -u)
basenames_alt=$(IFS='|'; echo "${SRC_BASENAMES[*]}")

mapfile -t TEXT_FILES < <(grep -rlE "src/(${basenames_alt})\.(cpp|hpp)" \
  --include="*.py" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.sh" . 2>/dev/null \
  | grep -v -e "^\./\.git/" -e "restructure.sh")

for file in "${TEXT_FILES[@]}"; do
  for old in "${!SRC_MAP[@]}"; do
    new="${SRC_MAP[$old]}"
    if grep -q "$old" "$file" 2>/dev/null; then
      sed -i "s|${old}|${new}|g" "$file"
    fi
  done
done
if [[ ${#TEXT_FILES[@]} -gt 0 ]]; then
  echo "  [ok] поправлено ${#TEXT_FILES[@]} файлов:"
  printf '       %s\n' "${TEXT_FILES[@]}"
else
  echo "  [ok] упоминаний не найдено"
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo " Готово. Дальше вручную:"
echo "   1. cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"
echo "      — убедиться, что C++ собирается."
echo "   2. cd front && npx vitest run   — убедиться, что JS-тесты проходят."
echo "   3. git status / git diff --stat — просмотреть итоговый список изменений."
echo "   4. git add -A && git commit -m 'restructure: split src/ and front/src/ by domain, move configs to config/'"
echo "════════════════════════════════════════════════════════════════"
