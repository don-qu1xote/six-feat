# syntax=docker/dockerfile:1
#
# Standalone Dockerfile for six-feat (the main service). Only compiles
# services/six-feat/ — not the other 3 services — via
# `cmake -S services/six-feat -B build`, which is possible because
# services/six-feat/CMakeLists.txt is itself a standalone CMake project
# (see cmake/EmbedSchema.cmake / libs/six-feat-common/CMakeLists.txt).
#
# Build context is still the repo root (not services/six-feat/ alone):
# libs/, schemas/ and cmake/ are shared siblings the service's own
# CMakeLists.txt reaches via a relative SIX_FEAT_ROOT (two levels up from
# services/six-feat), so the directory depth copied into the image must
# mirror the repo layout. See docker-compose.yml: context: . / dockerfile:
# services/six-feat/Dockerfile.

ARG USERVER_IMAGE=ghcr.io/userver-framework/ubuntu-22.04-userver:v3.0@sha256:f376113b11931e838b1e32ccf9d8ea30f061d4fecfaeb8d435fc3460337d8bc0

# ════════════════════════════════════════════════════════════════════════════
# Stage 1 — C++ Build
# ════════════════════════════════════════════════════════════════════════════
FROM ${USERVER_IMAGE} AS builder

# BUILD_JOBS caps compiler parallelism per service. `docker compose up -d`
# builds all 4 services concurrently by default, and each was independently
# using -j"$(nproc)" — on an N-core machine that's up to 4×N cc1plus
# processes competing for RAM at once, which OOM-kills the compiler on
# memory-constrained Docker Desktop VMs. Override with
# --build-arg BUILD_JOBS=<n> if your machine has RAM to spare.
ARG BUILD_JOBS=4

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends libssl-dev

WORKDIR /src
COPY cmake ./cmake
COPY schemas ./schemas
COPY libs ./libs
COPY services/six-feat ./services/six-feat

# CCACHE_DIR: shared cache-mount id (six-feat-ccache) across all 4 services'
# Dockerfiles — safe to share, unlike the per-service /src/build mount below,
# because ccache keys on (preprocessed source, compiler flags), not on any
# project/build-tree identity. All 4 services compile the same
# libs/six-feat-common sources with identical flags, so after the first
# service builds, the other 3 hit cache for nearly all of that shared work
# instead of recompiling it from scratch.
ENV CCACHE_DIR=/ccache
RUN --mount=type=cache,id=six-feat-ccache,target=/ccache,sharing=locked \
    --mount=type=cache,id=six-feat-build,target=/src/build,sharing=locked \
    cmake -S services/six-feat -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/install \
 && cmake --build build -j"${BUILD_JOBS}" \
 && cmake --install build

# ════════════════════════════════════════════════════════════════════════════
# Stage 2 — JS Bundle
# ════════════════════════════════════════════════════════════════════════════
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS js-builder

WORKDIR /front
COPY front/package.json front/package-lock.json ./
RUN npm ci
COPY front/src ./src
COPY front/scripts ./scripts
# Produces dist/script.<hash>.js (minified, content-hashed) plus
# dist/manifest.json ({"script": "script.<hash>.js"}) — see
# front/scripts/hash-build.mjs.
RUN npm run build

# ════════════════════════════════════════════════════════════════════════════
# Stage 3 — Runtime
# ════════════════════════════════════════════════════════════════════════════
# Minimal base — NOT the full userver dev/build image. six_feat statically
# links the userver framework itself; the only *dynamic* dependencies are
# Boost, libpq, OpenSSL and libc/libstdc++, all of which ship as regular
# Ubuntu 22.04 packages. Staying on ubuntu:22.04 (same distro/ABI the builder
# stage compiles against) avoids glibc/Boost SONAME mismatches that a switch
# to e.g. Debian slim would risk, while dropping the ~1GB+ of compilers,
# headers and build tooling the dev image carries.
FROM ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS runtime

# Without this, tzdata's postinst hits an interactive debconf prompt
# ("Please select the geographic area...") on a fresh apt-get
# install/upgrade — apt's own -y flag only auto-confirms yes/no questions,
# not debconf configuration dialogs, so it hangs forever with no TTY to
# answer it in a `docker build`. noninteractive makes debconf silently keep
# tzdata's packaged default instead of prompting.
ENV DEBIAN_FRONTEND=noninteractive

# libpq5                  — PostgreSQL client runtime .so, used by userver's
#   Postgres driver (userver::postgresql) for the actual wire protocol; its
#   own transitive deps (libldap, libgssapi-krb5, ...) are pulled in
#   automatically by apt when this package installs, same as for the other
#   ldd-derived entries below.
# libssl3                 — OpenSSL runtime (TLS for outbound Genius calls)
# ca-certificates         — CA trust bundle at /etc/ssl/certs/ca-certificates.crt,
#   required for TLS verification. Doesn't show up in `ldd` (it's data, not a
#   linked library) — easy to drop by accident if you trim this list purely
#   from an `ldd` run. Without it every HTTPS call fails at the TLS setup
#   step with "Problem with the SSL CA cert (path? access rights?)".
# curl                    — used by HEALTHCHECK
# tzdata                  — IANA zoneinfo database. Without it, userver's
#   HTTP cookie parser (userver/core/src/server/http/http_response_cookie.cpp)
#   can't resolve even "GMT" and logs "Error while parsing cookie timezone:
#   Can't load time zone: GMT" on every response that carries a Set-Cookie
#   with an HTTP-date Expires (e.g. every proxied Genius API response) —
#   harmless on its own, but noisy enough to bury real warnings in the logs.
# libc-ares2, libev4, libcrypto++8, libjemalloc2, libre2-9, libfmt8,
#   libcctz2, libyaml-cpp0.7 — direct runtime deps pulled in by the
#   statically-linked userver framework itself (async DNS, event loop,
#   crypto, allocator, regex, formatting, timezone and YAML parsing).
# libboost-*1.74.0 — runtime .so's for Boost 1.74 (the version six_feat was
#   linked against in the builder stage).
#   The ldd-derived part of this list (boost + the above, excluding libssl3
#   and ca-certificates) was taken from a complete `ldd /install/bin/six_feat`
#   run against the builder stage — re-run that and update this list if the
#   binary's dependencies ever change:
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

# Front-end files — paths must match static_config.yaml:
#   handler-index  → /usr/share/six_feat/index.html
#   handler-script → /usr/share/six_feat/<hashed script filename>
#
# The JS bundle keeps its content-hashed name (script.<hash>.js) all the way
# into the runtime image — no renaming to a static "script.js" here. The
# entrypoint reads SCRIPT_FILENAME (baked in below from js-builder's
# manifest.json) and writes it into config_vars.yaml so static_config.yaml's
# handler-script route/file-path and handler-index's injected reference both
# resolve to the exact same file.
COPY front/index.html /usr/share/six_feat/index.html
COPY --from=js-builder /front/dist/script.*.js /usr/share/six_feat/
COPY --from=js-builder /front/dist/manifest.json /tmp/manifest.json
RUN SCRIPT_FILENAME="$(sed -n 's/.*"script": *"\([^"]*\)".*/\1/p' /tmp/manifest.json)" \
 && test -n "$SCRIPT_FILENAME" \
 && echo "$SCRIPT_FILENAME" > /usr/share/six_feat/.script-filename \
 && rm /tmp/manifest.json

COPY services/six-feat/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /var/lib/six_feat \
 && chown -R six_feat:six_feat /app /var/lib/six_feat /usr/share/six_feat

EXPOSE 8080

# start-period covers docker-entrypoint.sh's bounded wait for Postgres to
# report ready via pg_isready (up to ~131s worst case: 120s master + 10s
# replica + 1s settle) plus normal app startup time, so a merely-slow-but-
# healthy boot — including one that's genuinely waiting out a slow Postgres
# bootstrap — isn't flagged unhealthy before it's had a real chance to come
# up.
HEALTHCHECK --interval=15s --timeout=5s --start-period=150s --retries=3 \
  CMD curl -f http://localhost:8080/readyz || exit 1

USER six_feat:six_feat

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
