# six-feat-genius-gateway — standalone Genius-API gateway service (IDEA-45).
# Links six_feat_core (see root CMakeLists.txt) instead of recompiling
# genius_gateway/resilience/internal_auth/request_id — the exact same
# ResiliencePipeline (CircuitBreaker/TokenBucket/LaneSemaphore/CooldownGate/
# RateLimiter) that six_feat and six_feat_enrichment already link, now
# centralized behind this service instead of being duplicated per-caller.
#
# No Postgres: this service only makes outbound HTTP calls to Genius, so
# unlike six_feat_enrichment it never appends components::Postgres /
# six_feat::PersistentStore / six_feat::ArtistRepository to its component list.

add_executable(six_feat_genius_gateway
    main.cpp
    internal_handlers.cpp
)

target_link_libraries(six_feat_genius_gateway
    PRIVATE six_feat_core
)

install(TARGETS six_feat_genius_gateway DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_genius_gateway)
