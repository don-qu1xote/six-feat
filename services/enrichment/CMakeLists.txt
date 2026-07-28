cmake_minimum_required(VERSION 3.22)
project(six_feat_enrichment_service CXX)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/presets/service.cmake)
six_feat_init_service()

six_feat_embed_schema(handlers/enrichment/enqueue_handler         kEnqueueHandlerSchema          ENRICHMENT_ENQUEUE_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/enrichment/internal_status_handler kInternalStatusHandlerSchema   ENRICHMENT_INTERNAL_STATUS_HANDLER_SCHEMA_HEADER)
# [SF-INF-03] /healthz now uses the shared six_feat::HealthHandler
# (libs/six-feat-common) instead of a local reimplementation — no schema of
# its own needed here anymore. /readyz is still enrichment-specific (its
# checks differ per service), hence its own schema below.
six_feat_embed_schema(handlers/enrichment/readiness_handler       kEnrichmentReadinessHandlerSchema ENRICHMENT_READINESS_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_enrichment_schema_headers DEPENDS
    ${ENRICHMENT_ENQUEUE_HANDLER_SCHEMA_HEADER}
    ${ENRICHMENT_INTERNAL_STATUS_HANDLER_SCHEMA_HEADER}
    ${ENRICHMENT_READINESS_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat_enrichment
    main.cpp
    internal_handlers.cpp
)

target_link_libraries(six_feat_enrichment
    PRIVATE six_feat_common
)

add_dependencies(six_feat_enrichment six_feat_enrichment_schema_headers)

six_feat_install_service(six_feat_enrichment six_feat_enrichment)
