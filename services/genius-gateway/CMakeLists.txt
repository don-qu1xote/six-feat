cmake_minimum_required(VERSION 3.22)
project(six_feat_genius_gateway_service CXX)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/presets/service.cmake)
six_feat_init_service()

six_feat_embed_schema(handlers/genius-gateway/artist_handler      kArtistHandlerSchema                 GENIUS_GATEWAY_ARTIST_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/genius-gateway/song_list_handler   kSongListHandlerSchema               GENIUS_GATEWAY_SONG_LIST_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/genius-gateway/song_handler        kSongHandlerSchema                   GENIUS_GATEWAY_SONG_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/genius-gateway/candidates_handler  kCandidatesHandlerSchema             GENIUS_GATEWAY_CANDIDATES_HANDLER_SCHEMA_HEADER)
# [SF-INF-03] /healthz now uses the shared six_feat::HealthHandler
# (libs/six-feat-common) instead of a local reimplementation — no schema of
# its own needed here anymore. /readyz is genius-gateway-specific (circuit
# breaker check), hence its own schema below.
six_feat_embed_schema(handlers/genius-gateway/readiness_handler   kGeniusGatewayReadinessHandlerSchema GENIUS_GATEWAY_READINESS_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_genius_gateway_schema_headers DEPENDS
    ${GENIUS_GATEWAY_ARTIST_HANDLER_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_SONG_LIST_HANDLER_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_SONG_HANDLER_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_CANDIDATES_HANDLER_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_READINESS_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat_genius_gateway
    main.cpp
    internal_handlers.cpp
)

target_link_libraries(six_feat_genius_gateway
    PRIVATE
        six_feat_core
        six_feat_genius
        six_feat_http
)

target_include_directories(six_feat_genius_gateway PRIVATE ${CMAKE_BINARY_DIR}/generated)

add_dependencies(six_feat_genius_gateway six_feat_genius_gateway_schema_headers)

six_feat_install_service(six_feat_genius_gateway six_feat_genius_gateway)
