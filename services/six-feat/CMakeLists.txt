# six-feat — main service, standalone CMake project.
# Build standalone:  cd services/six-feat && cmake -S . -B build
# (also buildable aggregated through the repo-root thin wrapper — see its
# own comment for why that's transitional)

cmake_minimum_required(VERSION 3.22)
project(six_feat_service CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

get_filename_component(SIX_FEAT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

find_package(userver COMPONENTS core postgresql REQUIRED)
find_package(OpenSSL REQUIRED)

if(NOT TARGET six_feat_common)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-common" "${CMAKE_BINARY_DIR}/six-feat-common")
endif()

include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(handlers/six-feat/graph_handler      kGraphHandlerSchema     GRAPH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/path_handler       kPathHandlerSchema      PATH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/search_handler     kSearchHandlerSchema    SEARCH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/status_handler     kStatusHandlerSchema    STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/sse_status_handler kSseStatusHandlerSchema SSE_STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/readiness_handler  kReadinessHandlerSchema READINESS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/static_handler     kStaticHandlerSchema    STATIC_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/image_proxy_handler kImageProxyHandlerSchema IMAGE_PROXY_HANDLER_SCHEMA_HEADER)

six_feat_embed_schema(components/enrichment_client         kEnrichmentClientComponentSchema         ENRICHMENT_CLIENT_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/collab_service            kCollabServiceComponentSchema            COLLAB_SERVICE_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/app_secret_parity_checker kAppSecretParityCheckerComponentSchema   APP_SECRET_PARITY_CHECKER_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_sixfeat_schema_headers DEPENDS
    ${GRAPH_HANDLER_SCHEMA_HEADER}
    ${PATH_HANDLER_SCHEMA_HEADER}
    ${SEARCH_HANDLER_SCHEMA_HEADER}
    ${STATUS_HANDLER_SCHEMA_HEADER}
    ${SSE_STATUS_HANDLER_SCHEMA_HEADER}
    ${READINESS_HANDLER_SCHEMA_HEADER}
    ${STATIC_HANDLER_SCHEMA_HEADER}
    ${IMAGE_PROXY_HANDLER_SCHEMA_HEADER}
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
    src/http/graph_handler.cpp
    src/http/path_handler.cpp
    src/http/search_handler.cpp
    src/http/readiness_handler.cpp
    src/http/status_handler.cpp
    src/http/static_handler.cpp
    src/http/sse_status_handler.cpp
    src/http/image_proxy_handler.cpp
)

target_include_directories(six_feat PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

target_link_libraries(six_feat
    PRIVATE
        six_feat_common
        OpenSSL::Crypto
)

add_dependencies(six_feat six_feat_sixfeat_schema_headers)

install(TARGETS six_feat DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat)
