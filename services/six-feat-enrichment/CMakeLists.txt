cmake_minimum_required(VERSION 3.22)
project(six_feat_enrichment_service CXX)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/presets/service.cmake)
six_feat_init_service()

six_feat_embed_schema(handlers/enrichment/enqueue_handler         kEnqueueHandlerSchema          ENRICHMENT_ENQUEUE_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/enrichment/internal_status_handler kInternalStatusHandlerSchema   ENRICHMENT_INTERNAL_STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/enrichment/readiness_handler       kEnrichmentReadinessHandlerSchema ENRICHMENT_READINESS_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_enrichment_service_schema_headers DEPENDS
    ${ENRICHMENT_ENQUEUE_HANDLER_SCHEMA_HEADER}
    ${ENRICHMENT_INTERNAL_STATUS_HANDLER_SCHEMA_HEADER}
    ${ENRICHMENT_READINESS_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat_enrichment_service
    src/main.cpp
    src/internal/enqueue_handler.cpp
    src/internal/status_handler.cpp
    src/system/readiness_handler.cpp
)

set_target_properties(six_feat_enrichment_service PROPERTIES OUTPUT_NAME six_feat_enrichment)

target_link_libraries(six_feat_enrichment_service
    PRIVATE
        six_feat_core
        six_feat_storage
        six_feat_genius
        six_feat_sources
        six_feat_enrichment
        six_feat_http
)

target_include_directories(six_feat_enrichment_service PRIVATE ${CMAKE_BINARY_DIR}/generated)

add_dependencies(six_feat_enrichment_service six_feat_enrichment_service_schema_headers)

six_feat_install_service(six_feat_enrichment_service six_feat_enrichment)
