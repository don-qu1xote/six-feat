# six-feat-common — code used by 2+ services, pulled in via add_subdirectory()
# from each services/<name>/CMakeLists.txt instead of being built once from a
# shared root CMakeLists.txt. Not independently buildable (relies on the
# calling service's find_package(userver ...) / find_package(OpenSSL ...)
# having already run) — this file only ever runs as a subdirectory of one of
# the 4 service projects.
#
#   - background-enrichment stack, Genius network layer + resilience, L1/L2
#     storage (incl. the graph-analytics primitives storage/analytics.hpp
#     depends on), domain types, inter-service auth helper — used by
#     six-feat, six-feat-enrichment, six-feat-genius-gateway.
#   - OAuth flow (oauth_handler) + session encryption (session_crypto) + the
#     generic /healthz handler — used by six-feat and six-feat-auth.
#
# SIX_FEAT_ROOT must already be set by the calling service's CMakeLists.txt.

include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(handlers/shared/oauth_handler  kOAuthHandlerSchema  OAUTH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/shared/health_handler kHealthHandlerSchema HEALTH_HANDLER_SCHEMA_HEADER)

six_feat_embed_schema(components/enrichment_worker     kEnrichmentWorkerComponentSchema     ENRICHMENT_WORKER_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/artist_repository     kArtistRepositoryComponentSchema     ARTIST_REPOSITORY_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/persistent_store      kPersistentStoreComponentSchema      PERSISTENT_STORE_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/genius_gateway        kGeniusGatewayComponentSchema        GENIUS_GATEWAY_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/genius_gateway_client kGeniusGatewayClientComponentSchema  GENIUS_GATEWAY_CLIENT_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_common_schema_headers DEPENDS
    ${OAUTH_HANDLER_SCHEMA_HEADER}
    ${HEALTH_HANDLER_SCHEMA_HEADER}
    ${ENRICHMENT_WORKER_COMPONENT_SCHEMA_HEADER}
    ${ARTIST_REPOSITORY_COMPONENT_SCHEMA_HEADER}
    ${PERSISTENT_STORE_COMPONENT_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_COMPONENT_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_CLIENT_COMPONENT_SCHEMA_HEADER}
)

# OBJECT, not STATIC: a STATIC archive only pulls in members that resolve an
# already-pending undefined symbol during ld's single left-to-right scan, so
# a member later in this list needing a symbol from a member earlier in the
# list (e.g. health_handler.cpp needing request_id.cpp's EnsureRequestId)
# links fine as loose objects but fails as a .a with "undefined reference".
add_library(six_feat_common OBJECT
    src/domain/role_mask.cpp
    src/core/resilience.cpp
    src/genius/genius_gateway.cpp
    src/genius/genius_gateway_client.cpp
    src/storage/persistent_store.cpp
    src/storage/analytics.cpp
    src/storage/artist_repository.cpp
    src/enrichment/enrichment_queue.cpp
    src/enrichment/enrichment_worker.cpp
    src/core/internal_auth.cpp
    src/core/internal_http.cpp
    src/core/request_id.cpp
    src/core/security_headers.cpp
    src/auth/oauth_handler.cpp
    src/auth/session_crypto.cpp
    src/http/health_handler.cpp
)

target_link_libraries(six_feat_common
    PUBLIC
        userver::core
        userver::postgresql
        OpenSSL::Crypto
)

target_include_directories(six_feat_common
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src
           ${CMAKE_BINARY_DIR}/generated
)

add_dependencies(six_feat_common six_feat_common_schema_headers)
