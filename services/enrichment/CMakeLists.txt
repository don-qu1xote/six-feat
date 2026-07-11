# six-feat-enrichment — standalone background-enrichment service (IDEA-25),
# standalone CMake project. Build standalone:
#   cd services/enrichment && cmake -S . -B build
# Links six_feat_common (libs/six-feat-common) instead of recompiling
# enrichment_queue/enrichment_worker/genius_gateway/resilience/
# persistent_store/artist_repository/domain_types.

cmake_minimum_required(VERSION 3.22)
project(six_feat_enrichment_service CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

get_filename_component(SIX_FEAT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

find_package(userver COMPONENTS core postgresql REQUIRED)
find_package(OpenSSL REQUIRED)

if(NOT TARGET six_feat_common)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-common" "${CMAKE_BINARY_DIR}/six-feat-common")
endif()

include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(handlers/enrichment/enqueue_handler         kEnqueueHandlerSchema          ENRICHMENT_ENQUEUE_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/enrichment/internal_status_handler kInternalStatusHandlerSchema   ENRICHMENT_INTERNAL_STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/enrichment/health_handler          kEnrichmentHealthHandlerSchema ENRICHMENT_HEALTH_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_enrichment_schema_headers DEPENDS
    ${ENRICHMENT_ENQUEUE_HANDLER_SCHEMA_HEADER}
    ${ENRICHMENT_INTERNAL_STATUS_HANDLER_SCHEMA_HEADER}
    ${ENRICHMENT_HEALTH_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat_enrichment
    main.cpp
    internal_handlers.cpp
)

target_link_libraries(six_feat_enrichment
    PRIVATE six_feat_common
)

add_dependencies(six_feat_enrichment six_feat_enrichment_schema_headers)

install(TARGETS six_feat_enrichment DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_enrichment)
