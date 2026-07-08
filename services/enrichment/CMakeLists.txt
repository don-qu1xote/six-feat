# six-feat-enrichment — standalone background-enrichment service (IDEA-25).
# Links six_feat_core (see root CMakeLists.txt) instead of recompiling
# enrichment_queue/enrichment_worker/genius_gateway/resilience/
# persistent_store/artist_repository/domain_types.

add_executable(six_feat_enrichment
    main.cpp
    internal_handlers.cpp
)

target_link_libraries(six_feat_enrichment
    PRIVATE six_feat_core
)

install(TARGETS six_feat_enrichment DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_enrichment)
