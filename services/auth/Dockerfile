# syntax=docker/dockerfile:1
#
# Standalone Dockerfile for six-feat-auth (IDEA-53). Only compiles
# services/auth/ — build context is still the repo root (libs/, schemas/,
# cmake/ are shared siblings — see services/six-feat/Dockerfile for the
# full rationale). See docker-compose.yml: context: . / dockerfile:
# services/auth/Dockerfile.

ARG USERVER_IMAGE=ghcr.io/userver-framework/ubuntu-22.04-userver:v3.0@sha256:f376113b11931e838b1e32ccf9d8ea30f061d4fecfaeb8d435fc3460337d8bc0

# ════════════════════════════════════════════════════════════════════════════
# Stage 1 — C++ Build
# ════════════════════════════════════════════════════════════════════════════
FROM ${USERVER_IMAGE} AS builder

# BUILD_JOBS caps compiler parallelism — see services/six-feat/Dockerfile
# for the full rationale (parallel `docker compose up -d` across 4 services
# oversubscribes memory at raw nproc parallelism).
ARG BUILD_JOBS=4

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends libssl-dev

WORKDIR /src
COPY cmake ./cmake
COPY schemas ./schemas
COPY libs ./libs
COPY services/auth ./services/auth

# CCACHE_DIR: shared cache-mount id (six-feat-ccache) across all 4 services'
# Dockerfiles — see services/six-feat/Dockerfile for the full rationale.
ENV CCACHE_DIR=/ccache
RUN --mount=type=cache,id=six-feat-ccache,target=/ccache,sharing=locked \
    --mount=type=cache,id=six-feat-auth-build,target=/src/build,sharing=locked \
    cmake -S services/auth -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/install \
 && cmake --build build -j"${BUILD_JOBS}" \
 && cmake --install build

# ════════════════════════════════════════════════════════════════════════════
# Stage 2 — Runtime
# ════════════════════════════════════════════════════════════════════════════
# See services/six-feat/Dockerfile for the full rationale behind this
# package list. No Postgres traffic at runtime, but libpq5 is still a
# transitive dependency of the statically-linked userver framework via
# libs/six-feat-common (userver::postgresql), same as every other service.
FROM ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS runtime

# See services/six-feat/Dockerfile for why this is needed (tzdata's
# interactive debconf prompt hangs `docker build` forever otherwise).
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

COPY services/auth/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN chown -R six_feat:six_feat /app

EXPOSE 8083

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8083/healthz || exit 1

USER six_feat:six_feat

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
