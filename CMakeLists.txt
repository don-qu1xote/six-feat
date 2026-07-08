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
# Used by src/auth/session_crypto.cpp for AES-256-GCM session encryption.
# OpenSSL is already a transitive dependency of userver (libssl-dev), but we
# link it explicitly so the EVP_* / SHA256 / RAND_bytes symbols resolve.
find_package(OpenSSL REQUIRED)

# ── Shared core library ───────────────────────────────────────────────────────
# The background-enrichment stack (queue/worker, Genius network layer +
# resilience, L1/L2 storage, domain types) plus the inter-service auth
# helper. Built once here and linked into both six_feat and
# services/enrichment's six_feat_enrichment (see services/enrichment/CMakeLists.txt)
# so that logic is never copy-pasted between the two binaries.
add_library(six_feat_core STATIC
    src/domain/role_mask.cpp
    src/core/resilience.cpp
    src/genius/genius_gateway.cpp
    src/genius/genius_gateway_client.cpp
    src/storage/persistent_store.cpp
    src/storage/artist_repository.cpp
    src/enrichment/enrichment_queue.cpp
    src/enrichment/enrichment_worker.cpp
    src/core/internal_auth.cpp
    src/core/internal_http.cpp
    src/core/request_id.cpp
    src/core/security_headers.cpp
)

target_link_libraries(six_feat_core
    PUBLIC
        userver::core
        userver::postgresql
)

target_include_directories(six_feat_core
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# ── Main service ──────────────────────────────────────────────────────────────
add_executable(six_feat
    src/genius/genius_error_mapping.cpp
    src/enrichment/enrichment_client.cpp
    src/core/collab_service.cpp
    src/storage/analytics.cpp
    src/http/graph_handler.cpp
    src/http/path_handler.cpp
    src/http/search_handler.cpp
    src/http/health_handler.cpp
    src/http/readiness_handler.cpp
    src/http/status_handler.cpp
    src/http/static_handler.cpp
    src/main.cpp
    src/http/sse_status_handler.cpp
    src/auth/session_crypto.cpp
    src/auth/oauth_handler.cpp
)

target_link_libraries(six_feat
    PRIVATE
        six_feat_core
        OpenSSL::Crypto
)

# ── Install ───────────────────────────────────────────────────────────────────
install(TARGETS six_feat DESTINATION bin)
install(FILES config/static_config.yaml DESTINATION etc/six_feat)

# ── Standalone background-enrichment service (IDEA-25) ───────────────────────
add_subdirectory(services/enrichment)

# ── Standalone Genius-API gateway service (IDEA-45) ───────────────────────────
add_subdirectory(services/genius-gateway)

# ── Standalone OAuth-flow service (IDEA-53) ───────────────────────────────────
# Owns /auth/login|callback|logout|me. Per-request session validation
# (RequireSession/ExtractToken) stays in six_feat itself — see
# src/auth/token_router.hpp and services/auth/CMakeLists.txt.
add_subdirectory(services/auth)
