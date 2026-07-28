cmake_minimum_required(VERSION 3.22)
project(six_feat_service CXX)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/presets/service.cmake)
six_feat_init_service()

six_feat_embed_schema(handlers/six-feat/artist_handler     kArtistHandlerSchema    ARTIST_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/graph_handler      kGraphHandlerSchema     GRAPH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/path_handler       kPathHandlerSchema      PATH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/search_handler     kSearchHandlerSchema    SEARCH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/status_handler     kStatusHandlerSchema    STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/sse_status_handler kSseStatusHandlerSchema SSE_STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/readiness_handler  kReadinessHandlerSchema READINESS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/static_handler     kStaticHandlerSchema    STATIC_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/image_proxy_handler kImageProxyHandlerSchema IMAGE_PROXY_HANDLER_SCHEMA_HEADER)
# [SF-GAME-13] Internal-mesh anti-cheat neighbours lookup.
six_feat_embed_schema(handlers/six-feat/internal_neighbours_handler kInternalNeighboursHandlerSchema INTERNAL_NEIGHBOURS_HANDLER_SCHEMA_HEADER)

six_feat_embed_schema(components/enrichment_client         kEnrichmentClientComponentSchema         ENRICHMENT_CLIENT_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/collab_service            kCollabServiceComponentSchema            COLLAB_SERVICE_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/app_secret_parity_checker kAppSecretParityCheckerComponentSchema   APP_SECRET_PARITY_CHECKER_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_sixfeat_schema_headers DEPENDS
    ${ARTIST_HANDLER_SCHEMA_HEADER}
    ${GRAPH_HANDLER_SCHEMA_HEADER}
    ${PATH_HANDLER_SCHEMA_HEADER}
    ${SEARCH_HANDLER_SCHEMA_HEADER}
    ${STATUS_HANDLER_SCHEMA_HEADER}
    ${SSE_STATUS_HANDLER_SCHEMA_HEADER}
    ${READINESS_HANDLER_SCHEMA_HEADER}
    ${STATIC_HANDLER_SCHEMA_HEADER}
    ${IMAGE_PROXY_HANDLER_SCHEMA_HEADER}
    ${INTERNAL_NEIGHBOURS_HANDLER_SCHEMA_HEADER}
    ${ENRICHMENT_CLIENT_COMPONENT_SCHEMA_HEADER}
    ${COLLAB_SERVICE_COMPONENT_SCHEMA_HEADER}
    ${APP_SECRET_PARITY_CHECKER_COMPONENT_SCHEMA_HEADER}
)

add_executable(six_feat
    src/main.cpp
    src/genius/genius_error_mapping.cpp
    src/enrichment/enrichment_client.cpp
    src/core/collab_service.cpp
    src/auth/app_secret_parity_checker.cpp
    src/http/artist_handler.cpp
    src/http/graph_handler.cpp
    src/http/path_handler.cpp
    src/http/search_handler.cpp
    src/http/readiness_handler.cpp
    src/http/status_handler.cpp
    src/http/static_handler.cpp
    src/http/sse_status_handler.cpp
    src/http/image_proxy_handler.cpp
    src/http/internal_neighbours_handler.cpp
)

target_include_directories(six_feat PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

target_link_libraries(six_feat
    PRIVATE
        six_feat_common
        OpenSSL::Crypto
)

add_dependencies(six_feat six_feat_sixfeat_schema_headers)

six_feat_install_service(six_feat six_feat)
