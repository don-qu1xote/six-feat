# syntax=docker/dockerfile:1

ARG USERVER_IMAGE=ghcr.io/userver-framework/ubuntu-22.04-userver:v3.0@sha256:f376113b11931e838b1e32ccf9d8ea30f061d4fecfaeb8d435fc3460337d8bc0

FROM ${USERVER_IMAGE} AS builder

# BUILD_JOBS: параллельная сборка 5 сервисов может превысить лимит RAM
ARG BUILD_JOBS=8

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends libssl-dev

WORKDIR /src
COPY cmake ./cmake
COPY schemas ./schemas
COPY libs ./libs
COPY services/.base ./services/.base
COPY services/six-feat ./services/six-feat

# CCACHE_DIR: общий cache-mount id для всех 5 Dockerfile'ов (общие libs/)
ENV CCACHE_DIR=/ccache
RUN --mount=type=cache,id=six-feat-ccache,target=/ccache,sharing=locked \
    --mount=type=cache,id=six-feat-build,target=/src/build,sharing=locked \
    cmake -S services/six-feat -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/install \
 && cmake --build build -j"${BUILD_JOBS}" \
 && cmake --install build --strip

FROM node:26-slim@sha256:4ebb5ace66f15a24c14c492e01a8beeed4fddf970a856109f5126e703e5fe503 AS js-builder

WORKDIR /front
COPY front/package.json front/package-lock.json ./
RUN npm ci
COPY front/src ./src
COPY front/scripts ./scripts
RUN npm run build

# ubuntu:22.04 — тот же ABI, под который собран builder (glibc/Boost SONAME)
FROM ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS runtime

# DEBIAN_FRONTEND=noninteractive: иначе tzdata зависает на debconf в docker build
ENV DEBIAN_FRONTEND=noninteractive

# Список пакетов выведен из ldd против builder — runtime-зависимости статически слинкованного userver;
# обновляйте, если изменятся зависимости бинарника: docker run --rm <builder> ldd /install/bin/six_feat
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

# Пути фронтенда должны совпадать со static_config.yaml; entrypoint читает
# .script-filename/.style-filename из manifest.json от js-builder
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

COPY front/vendor/vis-network.min.js /usr/share/six_feat/vendor/vis-network.min.js
COPY schemas/openapi/openapi.json /usr/share/six_feat/openapi.json

COPY services/.base /app/services/.base
COPY services/six-feat/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /var/lib/six_feat \
 && chown -R six_feat:six_feat /app /var/lib/six_feat /usr/share/six_feat

EXPOSE 8080

# start-period покрывает ожидание Postgres в docker-entrypoint.sh (pg_isready)
HEALTHCHECK --interval=15s --timeout=5s --start-period=150s --retries=3 \
  CMD curl -f http://localhost:8080/readyz || exit 1

USER six_feat:six_feat

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
