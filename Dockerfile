# syntax=docker/dockerfile:1

ARG USERVER_IMAGE=ghcr.io/userver-framework/ubuntu-22.04-userver:latest

# ════════════════════════════════════════════════════════════════════════════
# Stage 1 — Build
# ════════════════════════════════════════════════════════════════════════════
FROM ${USERVER_IMAGE} AS builder

# libsqlite3-dev — required by find_package(SQLite3); not present in base image
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt ./
COPY src ./src
COPY static_config.yaml ./

RUN cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/install \
 && cmake --build build -j"$(nproc)" \
 && cmake --install build

# ════════════════════════════════════════════════════════════════════════════
# Stage 2 — Runtime
# ════════════════════════════════════════════════════════════════════════════
FROM ${USERVER_IMAGE} AS runtime

# libsqlite3-0 — runtime .so only (no headers)
# curl         — used by HEALTHCHECK
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-0 curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /install/bin/six_feat                     ./six_feat
COPY --from=builder /install/etc/six_feat/static_config.yaml ./static_config.yaml

# Front-end files — paths must match static_config.yaml:
#   handler-index  → /usr/share/six_feat/index.html
#   handler-script → /usr/share/six_feat/script.js
COPY front/ /usr/share/six_feat/

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /var/lib/six_feat
VOLUME ["/var/lib/six_feat"]

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8080/api/v1/graph || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
