cmake_minimum_required(VERSION 3.22)
project(six_feat CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── userver ──────────────────────────────────────────────────────────────────
# The ubuntu-22.04-userver image ships userver::core which already includes
# the HTTP client/server components. Listing "http" as a separate component
# causes CMake to look for userver-http-config.cmake which does not exist
# in this image variant → removed.
#
# If you switch to an image that DOES package http separately, restore:
#   find_package(userver COMPONENTS core http REQUIRED)
#
# "postgresql" pulls in userver's native Postgres component (persistent_store
# talks to it via components::Postgres / storages::postgres::Cluster) — its
# headers/libpq ship in the ubuntu-22.04-userver image already, no extra
# apt-get package required (unlike SQLite3 previously).
find_package(userver COMPONENTS core postgresql REQUIRED)

# ── OpenSSL ───────────────────────────────────────────────────────────────────
# Used by src/shared/auth/session_crypto.cpp for AES-256-GCM session
# encryption. OpenSSL is already a transitive dependency of userver
# (libssl-dev), but we link it explicitly so the EVP_* / SHA256 / RAND_bytes
# symbols resolve. PUBLIC on six_feat_core below, so every service that
# links it (six-feat, six-feat-auth) gets it transitively.
find_package(OpenSSL REQUIRED)

# ── Config schemas (IDEA-54) ────────────────────────────────────────────────
# GetStaticConfigSchema() bodies live as YAML files under schemas/handlers/
# (shared with every services/*/CMakeLists.txt) instead of inline R"(...)"
# strings. Each is embedded into a generated header at build time — see
# cmake/EmbedSchema.cmake. This file only embeds schemas for handlers
# compiled into six_feat_core itself (oauth-config, healthz) — six-feat's
# own handler schemas are embedded in services/six-feat/CMakeLists.txt.
include("${CMAKE_SOURCE_DIR}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(shared/oauth_handler  kOAuthHandlerSchema  OAUTH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(shared/health_handler kHealthHandlerSchema HEALTH_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_schema_headers DEPENDS
    ${OAUTH_HANDLER_SCHEMA_HEADER}
    ${HEALTH_HANDLER_SCHEMA_HEADER}
)

# ── Shared core library ───────────────────────────────────────────────────────
# Code used by 2+ services lives here instead of being copy-pasted or
# recompiled per binary:
#   - background-enrichment stack, Genius network layer + resilience, L1/L2
#     storage, domain types, inter-service auth helper — used by six-feat,
#     six-feat-enrichment, six-feat-genius-gateway.
#   - OAuth flow (oauth_handler) + session encryption (session_crypto) + the
#     generic /healthz handler — used by six-feat and six-feat-auth.
# See src/shared/ for the source tree; each services/<name>/CMakeLists.txt
# links this instead of recompiling any of it.
add_library(six_feat_core STATIC
    src/shared/domain/role_mask.cpp
    src/shared/core/resilience.cpp
    src/shared/genius/genius_gateway.cpp
    src/shared/genius/genius_gateway_client.cpp
    src/shared/storage/persistent_store.cpp
    src/shared/storage/artist_repository.cpp
    src/shared/enrichment/enrichment_queue.cpp
    src/shared/enrichment/enrichment_worker.cpp
    src/shared/core/internal_auth.cpp
    src/shared/core/internal_http.cpp
    src/shared/core/request_id.cpp
    src/shared/core/security_headers.cpp
    src/shared/auth/oauth_handler.cpp
    src/shared/auth/session_crypto.cpp
    src/shared/http/health_handler.cpp
)

target_link_libraries(six_feat_core
    PUBLIC
        userver::core
        userver::postgresql
        OpenSSL::Crypto
)

target_include_directories(six_feat_core
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/shared
           ${CMAKE_BINARY_DIR}/generated
)

add_dependencies(six_feat_core six_feat_schema_headers)

# ── Services ──────────────────────────────────────────────────────────────────
# Each owns its own main.cpp/handlers/static_config.yaml/docker-entrypoint.sh
# under services/<name>/ and links six_feat_core for shared code.
add_subdirectory(services/six-feat)
add_subdirectory(services/enrichment)
add_subdirectory(services/genius-gateway)
add_subdirectory(services/auth)
