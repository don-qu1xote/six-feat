include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(components/enrichment_worker kEnrichmentWorkerComponentSchema ENRICHMENT_WORKER_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/prune_task        kPruneTaskComponentSchema        PRUNE_TASK_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_enrichment_schema_headers DEPENDS
    ${ENRICHMENT_WORKER_COMPONENT_SCHEMA_HEADER}
    ${PRUNE_TASK_COMPONENT_SCHEMA_HEADER}
)

add_library(six_feat_enrichment STATIC
    src/enrichment_queue.cpp
    src/enrichment_worker.cpp
    src/prune_task.cpp
)

target_include_directories(six_feat_enrichment PUBLIC include)
target_include_directories(six_feat_enrichment PRIVATE ${CMAKE_BINARY_DIR}/generated)

target_link_libraries(six_feat_enrichment PUBLIC
    userver::core
    six_feat_domain
    six_feat_core
    six_feat_storage
    six_feat_genius
    six_feat_common
    six_feat_sources
)

add_dependencies(six_feat_enrichment six_feat_enrichment_schema_headers)
