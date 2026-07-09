# six-feat — main service (/api/v1/graph, /path, /search, /status(/stream),
# /, /healthz, /readyz, plus local session validation via
# src/auth/token_router.hpp). Links six_feat_core (see root CMakeLists.txt)
# for shared code: storage, Genius network layer, background-enrichment
# queue/worker, OAuth flow + session crypto + the generic healthz handler.
# Everything below is specific to this service only.

# ── Config schemas (IDEA-54) ────────────────────────────────────────────────
# This service's own handlers — see cmake/EmbedSchema.cmake / root
# CMakeLists.txt for the shared codegen mechanism and schemas/handlers/
# layout. oauth-config/healthz schemas are embedded once in the root
# CMakeLists.txt instead (six_feat_core compiles those translation units).
include("${CMAKE_SOURCE_DIR}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(six-feat/graph_handler      kGraphHandlerSchema     GRAPH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(six-feat/path_handler       kPathHandlerSchema      PATH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(six-feat/search_handler     kSearchHandlerSchema    SEARCH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(six-feat/status_handler     kStatusHandlerSchema    STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(six-feat/sse_status_handler kSseStatusHandlerSchema SSE_STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(six-feat/readiness_handler  kReadinessHandlerSchema READINESS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(six-feat/static_handler     kStaticHandlerSchema    STATIC_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_sixfeat_schema_headers DEPENDS
    ${GRAPH_HANDLER_SCHEMA_HEADER}
    ${PATH_HANDLER_SCHEMA_HEADER}
    ${SEARCH_HANDLER_SCHEMA_HEADER}
    ${STATUS_HANDLER_SCHEMA_HEADER}
    ${SSE_STATUS_HANDLER_SCHEMA_HEADER}
    ${READINESS_HANDLER_SCHEMA_HEADER}
    ${STATIC_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat
    src/main.cpp
    src/genius/genius_error_mapping.cpp
    src/enrichment/enrichment_client.cpp
    src/core/collab_service.cpp
    src/storage/analytics.cpp
    src/http/graph_handler.cpp
    src/http/path_handler.cpp
    src/http/search_handler.cpp
    src/http/readiness_handler.cpp
    src/http/status_handler.cpp
    src/http/static_handler.cpp
    src/http/sse_status_handler.cpp
)

target_include_directories(six_feat PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

target_link_libraries(six_feat
    PRIVATE
        six_feat_core
        OpenSSL::Crypto
)

add_dependencies(six_feat six_feat_sixfeat_schema_headers)

install(TARGETS six_feat DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat)
