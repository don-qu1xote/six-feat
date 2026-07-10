# six-feat-genius-gateway — standalone Genius-API gateway service (IDEA-45),
# standalone CMake project. Build standalone:
#   cd services/genius-gateway && cmake -S . -B build
# Links six_feat_common (libs/six-feat-common) instead of recompiling
# genius_gateway/resilience/internal_auth/request_id.
#
# No Postgres: this service only makes outbound HTTP calls to Genius, so
# unlike six_feat_enrichment it never appends components::Postgres /
# six_feat::PersistentStore / six_feat::ArtistRepository to its component list
# (still links six_feat_common, which itself needs userver::postgresql).

cmake_minimum_required(VERSION 3.22)
project(six_feat_genius_gateway_service CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

get_filename_component(SIX_FEAT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

find_package(userver COMPONENTS core postgresql REQUIRED)
find_package(OpenSSL REQUIRED)

if(NOT TARGET six_feat_common)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-common" "${CMAKE_BINARY_DIR}/six-feat-common")
endif()

include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

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
    PRIVATE six_feat_common
)

add_dependencies(six_feat_genius_gateway six_feat_genius_gateway_schema_headers)

install(TARGETS six_feat_genius_gateway DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_genius_gateway)
