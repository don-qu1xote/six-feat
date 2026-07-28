# syntax=docker/dockerfile:1
#
# Автономный Dockerfile для six-feat (основной сервис). Собирает только
# services/six-feat/ — не остальные 3 сервиса — через
# `cmake -S services/six-feat -B build`, т.к.
# services/six-feat/CMakeLists.txt сам по себе является самостоятельным
# CMake-проектом (см. cmake/EmbedSchema.cmake / libs/six-feat-common/CMakeLists.txt).
#
# Контекст сборки — корень репозитория (не services/six-feat/ отдельно):
# libs/, schemas/ и cmake/ — общие соседние каталоги, до которых собственный
# CMakeLists.txt сервиса обращается через относительный SIX_FEAT_ROOT (на два
# уровня выше из services/six-feat), поэтому глубина копируемых в образ
# каталогов должна зеркалировать структуру репозитория. См. docker-compose.yml:
# context: . / dockerfile: services/six-feat/Dockerfile.

ARG USERVER_IMAGE=ghcr.io/userver-framework/ubuntu-22.04-userver:v3.0@sha256:f376113b11931e838b1e32ccf9d8ea30f061d4fecfaeb8d435fc3460337d8bc0

# ════════════════════════════════════════════════════════════════════════════
# Stage 1 — C++ Build
# ════════════════════════════════════════════════════════════════════════════
FROM ${USERVER_IMAGE} AS builder

# BUILD_JOBS ограничивает параллелизм компиляции на сервис. `docker compose up -d`
# по умолчанию собирает все 4 сервиса одновременно, и каждый независимо
# использовал -j"$(nproc)" — на N-ядерной машине получается до 4×N процессов
# cc1plus, конкурирующих за RAM, что приводит к OOM-kill компилятора на
# ограниченных по памяти Docker Desktop VM. Переопределить через
# --build-arg BUILD_JOBS=<n>, если на машине достаточно RAM.
ARG BUILD_JOBS=8

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends libssl-dev

WORKDIR /src
COPY cmake ./cmake
COPY schemas ./schemas
COPY libs ./libs
COPY services/six-feat ./services/six-feat

# CCACHE_DIR: общий cache-mount id (six-feat-ccache) для всех 4 Dockerfile'ов —
# безопасно для совместного использования (в отличие от per-service /src/build),
# т.к. ccache ключуется на (препроцессированный исходник, флаги компилятора),
# а не на идентичность проекта/дерева сборки. Все 4 сервиса компилируют одни и
# те же libs/six-feat-common исходники с идентичными флагами, поэтому после
# сборки первого сервиса остальные 3 попадают в кеш почти для всей общей
# работы вместо перекомпиляции с нуля.
ENV CCACHE_DIR=/ccache
RUN --mount=type=cache,id=six-feat-ccache,target=/ccache,sharing=locked \
    --mount=type=cache,id=six-feat-build,target=/src/build,sharing=locked \
    cmake -S services/six-feat -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/install \
 && cmake --build build -j"${BUILD_JOBS}" \
 && cmake --install build --strip

# ════════════════════════════════════════════════════════════════════════════
# Stage 2 — JS Bundle
# ════════════════════════════════════════════════════════════════════════════
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS js-builder

WORKDIR /front
COPY front/package.json front/package-lock.json ./
RUN npm ci
COPY front/src ./src
COPY front/scripts ./scripts
# Создаёт dist/script.<hash>.js и dist/style.<hash>.css (минифицированные,
# с хешем содержимого) плюс dist/manifest.json ({"script": ..., "style": ...}) —
# см. front/scripts/hash-build.mjs. CSS-бандл добавлен сюда же.
RUN npm run build

# ════════════════════════════════════════════════════════════════════════════
# Stage 3 — Runtime
# ════════════════════════════════════════════════════════════════════════════
# Минимальная база — НЕ полный образ userver dev/build. six_feat статически
# линкует сам userver; единственные *динамические* зависимости — Boost, libpq,
# OpenSSL и libc/libstdc++, все из стандартных пакетов Ubuntu 22.04.
# Оставаясь на ubuntu:22.04 (тот же дистрибутив/ABI, под который собирался
# builder stage) избегаем несовместимости glibc/Boost SONAME, которая
# возникла бы при переключении на, например, Debian slim, при этом сбрасывая
# ~1ГБ+ компиляторов, заголовков и инструментов сборки из dev-образа.
FROM ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS runtime

# Без этого tzdata при postinst показывает интерактивный debconf-диалог
# ("Please select the geographic area...") при apt-get install/upgrade —
# флаг apt -y подтверждает только yes/no вопросы, но не диалоги debconf,
# поэтому сборка зависает навсегда без TTY в `docker build`. noninteractive
# заставляет debconf молча принять значение пакета по умолчанию.
ENV DEBIAN_FRONTEND=noninteractive

# libpq5                  — клиентская .so PostgreSQL, используется драйвером
#   userver::postgresql для wire-протокола; транзитивные зависимости
#   (libldap, libgssapi-krb5, ...) подтягиваются apt автоматически.
# libssl3                 — OpenSSL runtime (TLS для исходящих вызовов Genius)
# ca-certificates         — CA trust bundle в /etc/ssl/certs/ca-certificates.crt,
#   необходим для верификации TLS. Не показывается в `ldd` (это данные, не
#   библиотека) — легко пропустить, обрезая список только по `ldd`. Без него
#   каждый HTTPS-запрос падает на этапе TLS с "Problem with the SSL CA cert".
# curl                    — используется HEALTHCHECK
# tzdata                  — база IANA zoneinfo. Без неё парсер cookie userver
#   не может резолвить даже "GMT" и логирует "Error while parsing cookie
#   timezone: Can't load time zone: GMT" на каждый ответ с Set-Cookie,
#   содержащим HTTP-date Expires — безвредно, но шумно.
# libc-ares2, libev4, libcrypto++8, libjemalloc2, libre2-9, libfmt8,
#   libcctz2, libyaml-cpp0.7 — прямые runtime-зависимости статически
#   слинкованного userver (async DNS, event loop, crypto, allocator,
#   regex, formatting, timezone, YAML parsing).
# libboost-*1.74.0 — runtime .so для Boost 1.74 (версия, с которой six_feat
#   был слинкован в builder stage).
#   ldd-выведенная часть списка (boost + указанные выше, исключая libssl3
#   и ca-certificates) взята из полного `ldd /install/bin/six_feat`,
#   запущенного против builder stage — перезапустите и обновите список,
#   если зависимости бинарного файла когда-либо изменятся:
#     docker build -f services/six-feat/Dockerfile --target builder -t six-feat-builder .
#     docker run --rm six-feat-builder ldd /install/bin/six_feat
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      libpq5 libssl3 ca-certificates curl \
      postgresql-client \
      tzdata \
      libc-ares2 \
      libev4 \
      libcrypto++8 \
      libjemalloc2 \
      libre2-9 \
      libfmt8 \
      libcctz2 \
      libyaml-cpp0.7 \
      libboost-atomic1.74.0 \
      libboost-filesystem1.74.0 \
      libboost-iostreams1.74.0 \
      libboost-program-options1.74.0 \
      libboost-stacktrace1.74.0 \
 && apt-mark manual \
      tzdata \
      libc-ares2 \
      libev4 \
      libcrypto++8 \
      libjemalloc2 \
      libre2-9 \
      libfmt8 \
      libcctz2 \
      libyaml-cpp0.7 \
      libboost-atomic1.74.0 \
      libboost-filesystem1.74.0 \
      libboost-iostreams1.74.0 \
      libboost-program-options1.74.0 \
      libboost-stacktrace1.74.0 \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system six_feat \
 && useradd --system --gid six_feat --no-create-home --shell /usr/sbin/nologin six_feat

WORKDIR /app

COPY --from=builder /install/bin/six_feat                     ./six_feat
COPY --from=builder /install/etc/six_feat/static_config.yaml ./static_config.yaml

# Файлы фронтенда — пути должны совпадать с static_config.yaml:
#   handler-index              → /usr/share/six_feat/index.html
#   handler-script             → /usr/share/six_feat/<хешированное имя скрипта>
#   handler-style              → /usr/share/six_feat/<хешированное имя стиля>
#   handler-vendor-vis-network → /usr/share/six_feat/vendor/vis-network.min.js
#   handler-openapi            → /usr/share/six_feat/openapi.json
#
# JS/CSS-бандлы сохраняют свои content-hashed имена (script.<hash>.js,
# style.<hash>.css) прямо в runtime-образе — переименования в статическое
# имя здесь нет. Entrypoint читает SCRIPT_FILENAME/STYLE_FILENAME
# (записаны ниже из manifest.json от js-builder) и записывает их в
# config_vars.yaml, чтобы handler-script/handler-style маршруты/пути и
# ссылки, внедрённые handler-index, все резолвились в одни и те же файлы.
COPY front/index.html /usr/share/six_feat/index.html
COPY --from=js-builder /front/dist/script.*.js /usr/share/six_feat/
COPY --from=js-builder /front/dist/style.*.css /usr/share/six_feat/
COPY --from=js-builder /front/dist/manifest.json /tmp/manifest.json
RUN SCRIPT_FILENAME="$(sed -n 's/.*"script": *"\([^"]*\)".*/\1/p' /tmp/manifest.json)" \
 && STYLE_FILENAME="$(sed -n 's/.*"style": *"\([^"]*\)".*/\1/p' /tmp/manifest.json)" \
 && test -n "$SCRIPT_FILENAME" \
 && test -n "$STYLE_FILENAME" \
 && echo "$SCRIPT_FILENAME" > /usr/share/six_feat/.script-filename \
 && echo "$STYLE_FILENAME" > /usr/share/six_feat/.style-filename \
 && rm /tmp/manifest.json

# Self-hosted vis-network vendor bundle (см. front/vendor/ —
# vis-network@9.1.9/standalone/umd/vis-network.min.js, зафиксирован как
# исходный файл, а не загружается при сборке) — заменяет старый тег
# <script src=...> с unpkg.com CDN в front/index.html.
COPY front/vendor/vis-network.min.js /usr/share/six_feat/vendor/vis-network.min.js

# Зафиксированный в репозитории статический OpenAPI 3.1 документ — см.
# собственный комментарий в schemas/openapi/openapi.json и OpenApiHandler
# в static_handler.hpp.
COPY schemas/openapi/openapi.json /usr/share/six_feat/openapi.json

COPY services/six-feat/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /var/lib/six_feat \
 && chown -R six_feat:six_feat /app /var/lib/six_feat /usr/share/six_feat

EXPOSE 8080

# start-period покрывает ограниченное ожидание Postgres в docker-entrypoint.sh
# через pg_isready (до ~131с в худшем случае: 120s master + 10s replica + 1s
# settle) плюс нормальное время старта приложения, чтобы медленная, но
# здоровая загрузка — включая ожидание медленного Postgres bootstrap — не
# помечалась как нездоровая, пока у неё не было реального шанса запуститься.
HEALTHCHECK --interval=15s --timeout=5s --start-period=150s --retries=3 \
  CMD curl -f http://localhost:8080/readyz || exit 1

USER six_feat:six_feat

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
