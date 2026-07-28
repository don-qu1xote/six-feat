# syntax=docker/dockerfile:1
#
# Автономный Dockerfile для six-feat-auth. Собирает только
# services/auth/ — контекст сборки — корень репозитория (libs/, schemas/,
# cmake/ — общие соседние каталоги — полное обоснование в
# services/six-feat/Dockerfile). См. docker-compose.yml: context: . /
# dockerfile: services/auth/Dockerfile.

ARG USERVER_IMAGE=ghcr.io/userver-framework/ubuntu-22.04-userver:v3.0@sha256:f376113b11931e838b1e32ccf9d8ea30f061d4fecfaeb8d435fc3460337d8bc0

# ════════════════════════════════════════════════════════════════════════════
# Stage 1 — C++ Build
# ════════════════════════════════════════════════════════════════════════════
FROM ${USERVER_IMAGE} AS builder

# BUILD_JOBS ограничивает параллелизм компиляции — полное обоснование в
# services/six-feat/Dockerfile (параллельный `docker compose up -d` 5 сервисов
# превышает лимиты памяти при полном nproc parallelism).
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
COPY services/auth ./services/auth

# CCACHE_DIR: общий cache-mount id (six-feat-ccache) для всех 5 Dockerfile'ов —
# полное обоснование в services/six-feat/Dockerfile.
ENV CCACHE_DIR=/ccache
RUN --mount=type=cache,id=six-feat-ccache,target=/ccache,sharing=locked \
    --mount=type=cache,id=six-feat-auth-build,target=/src/build,sharing=locked \
    cmake -S services/auth -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/install \
 && cmake --build build -j"${BUILD_JOBS}" \
 && cmake --install build --strip

# ════════════════════════════════════════════════════════════════════════════
# Stage 2 — Runtime
# ════════════════════════════════════════════════════════════════════════════
# Полное обоснование списка пакетов — в services/six-feat/Dockerfile.
# Нет Postgres-трафика в runtime, но libpq5 всё ещё транзитивная зависимость
# статически слинкованного userver через libs/six-feat-core
# (userver::postgresql), как и в каждом другом сервисе.
FROM ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS runtime

# Зачем это нужно — в services/six-feat/Dockerfile (интерактивный debconf
# от tzdata иначе навсегда зависает в `docker build`).
ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      libpq5 libssl3 ca-certificates curl \
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

COPY --from=builder /install/bin/six_feat_auth ./six_feat_auth
COPY --from=builder /install/etc/six_feat_auth/static_config.yaml ./static_config.yaml

COPY services/.base /app/services/.base
COPY services/auth/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN chown -R six_feat:six_feat /app

EXPOSE 8083

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8083/healthz || exit 1

USER six_feat:six_feat

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
