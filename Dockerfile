# syntax=docker/dockerfile:1

ARG USERVER_IMAGE=ghcr.io/userver-framework/ubuntu-22.04-userver:v3.0@sha256:f376113b11931e838b1e32ccf9d8ea30f061d4fecfaeb8d435fc3460337d8bc0

# ════════════════════════════════════════════════════════════════════════════
# Stage 1 — C++ Build
# ════════════════════════════════════════════════════════════════════════════
FROM ${USERVER_IMAGE} AS builder

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends libssl-dev

WORKDIR /src
COPY CMakeLists.txt ./
COPY cmake ./cmake
COPY schemas ./schemas
COPY src ./src
COPY services ./services

RUN --mount=type=cache,target=/src/build,sharing=locked \
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/install \
 && cmake --build build -j"$(nproc)" \
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
# Stage 3 — Runtime base (shared by six_feat and six-feat-enrichment)
# ════════════════════════════════════════════════════════════════════════════
# Minimal base — NOT the full userver dev/build image. Both binaries
# statically link the userver framework itself; the only *dynamic*
# dependencies are Boost, libpq, OpenSSL and libc/libstdc++, all of which
# ship as regular Ubuntu 22.04 packages. Staying on ubuntu:22.04 (same
# distro/ABI the builder stage compiles against) avoids glibc/Boost SONAME
# mismatches that a switch to e.g. Debian slim would risk, while dropping
# the ~1GB+ of compilers, headers and build tooling the dev image carries.
FROM ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS runtime-base

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
#     docker build --target builder -t six-feat-builder .
#     docker run --rm six-feat-builder ldd /install/bin/six_feat
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

# Unprivileged user both services run as (no login shell, no home dir needed).
RUN groupadd --system six_feat \
 && useradd --system --gid six_feat --no-create-home --shell /usr/sbin/nologin six_feat

# ════════════════════════════════════════════════════════════════════════════
# Stage 4 — Runtime (six-feat-enrichment, IDEA-25)
# ════════════════════════════════════════════════════════════════════════════
FROM runtime-base AS runtime-enrichment

WORKDIR /app

COPY --from=builder /install/bin/six_feat_enrichment ./six_feat_enrichment
COPY --from=builder /install/etc/six_feat_enrichment/static_config.yaml ./static_config.yaml

COPY services/enrichment/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /var/lib/six_feat_enrichment \
 && chown -R six_feat:six_feat /app /var/lib/six_feat_enrichment

EXPOSE 8081

# start-period covers docker-entrypoint.sh's bounded wait for Postgres to
# become reachable (up to ~26s: 20s master + 5s replica + 1s settle) plus
# normal app startup time, so a merely-slow-but-healthy boot isn't flagged
# unhealthy before it's had a real chance to come up.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -f http://localhost:8081/healthz || exit 1

USER six_feat:six_feat

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# ════════════════════════════════════════════════════════════════════════════
# Stage 5 — Runtime (six-feat-genius-gateway, IDEA-45/46)
# ════════════════════════════════════════════════════════════════════════════
FROM runtime-base AS runtime-genius-gateway

WORKDIR /app

COPY --from=builder /install/bin/six_feat_genius_gateway ./six_feat_genius_gateway
COPY --from=builder /install/etc/six_feat_genius_gateway/static_config.yaml ./static_config.yaml

COPY services/genius-gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN chown -R six_feat:six_feat /app

EXPOSE 8082

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8082/healthz || exit 1

USER six_feat:six_feat

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# ════════════════════════════════════════════════════════════════════════════
# Stage 6 — Runtime (six-feat-auth, IDEA-53)
# ════════════════════════════════════════════════════════════════════════════
FROM runtime-base AS runtime-auth

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

# ════════════════════════════════════════════════════════════════════════════
# Stage 7 — Runtime (six_feat, main service)
# ════════════════════════════════════════════════════════════════════════════
FROM runtime-base AS runtime

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
# become reachable (up to ~26s: 20s master + 5s replica + 1s settle) plus
# normal app startup time, so a merely-slow-but-healthy boot isn't flagged
# unhealthy before it's had a real chance to come up.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -f http://localhost:8080/readyz || exit 1

USER six_feat:six_feat

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
