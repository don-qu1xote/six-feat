# six-feat-enrichment — standalone background-enrichment service (IDEA-25).
# Links six_feat_core (see root CMakeLists.txt) instead of recompiling
# enrichment_queue/enrichment_worker/genius_gateway/resilience/
# persistent_store/artist_repository/domain_types.

# ── Config schemas (IDEA-54) ────────────────────────────────────────────────
# This service's own handlers (EnqueueHandler/InternalStatusHandler/
# HealthHandler) — see cmake/EmbedSchema.cmake / root CMakeLists.txt for the
# shared codegen mechanism and schemas/handlers/ layout.
include("${CMAKE_SOURCE_DIR}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(enrichment/enqueue_handler         kEnqueueHandlerSchema          ENRICHMENT_ENQUEUE_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(enrichment/internal_status_handler kInternalStatusHandlerSchema   ENRICHMENT_INTERNAL_STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(enrichment/health_handler          kEnrichmentHealthHandlerSchema ENRICHMENT_HEALTH_HANDLER_SCHEMA_HEADER)

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
    PRIVATE six_feat_core
)

add_dependencies(six_feat_enrichment six_feat_enrichment_schema_headers)

install(TARGETS six_feat_enrichment DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_enrichment)
