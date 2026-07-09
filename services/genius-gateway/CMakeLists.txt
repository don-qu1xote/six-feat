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

# ── Config schemas (IDEA-54) ────────────────────────────────────────────────
# This service's own handlers (ArtistHandler/SongListHandler/SongHandler/
# CandidatesHandler/HealthHandler) — see cmake/EmbedSchema.cmake / root
# CMakeLists.txt for the shared codegen mechanism and schemas/handlers/
# layout.
include("${CMAKE_SOURCE_DIR}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(genius-gateway/artist_handler     kArtistHandlerSchema             GENIUS_GATEWAY_ARTIST_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(genius-gateway/song_list_handler   kSongListHandlerSchema           GENIUS_GATEWAY_SONG_LIST_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(genius-gateway/song_handler        kSongHandlerSchema               GENIUS_GATEWAY_SONG_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(genius-gateway/candidates_handler  kCandidatesHandlerSchema         GENIUS_GATEWAY_CANDIDATES_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(genius-gateway/health_handler      kGeniusGatewayHealthHandlerSchema GENIUS_GATEWAY_HEALTH_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_genius_gateway_schema_headers DEPENDS
    ${GENIUS_GATEWAY_ARTIST_HANDLER_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_SONG_LIST_HANDLER_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_SONG_HANDLER_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_CANDIDATES_HANDLER_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_HEALTH_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat_genius_gateway
    main.cpp
    internal_handlers.cpp
)

target_link_libraries(six_feat_genius_gateway
    PRIVATE six_feat_core
)

add_dependencies(six_feat_genius_gateway six_feat_genius_gateway_schema_headers)

install(TARGETS six_feat_genius_gateway DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_genius_gateway)
