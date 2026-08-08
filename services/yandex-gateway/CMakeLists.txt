cmake_minimum_required(VERSION 3.22)
project(six_feat_yandex_gateway_service CXX)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/presets/service.cmake)
six_feat_init_service()

six_feat_embed_schema(handlers/yandex-gateway/track_artists_handler  kTrackArtistsHandlerSchema  YANDEX_GATEWAY_TRACK_ARTISTS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/yandex-gateway/search_artist_handler  kSearchArtistHandlerSchema  YANDEX_GATEWAY_SEARCH_ARTIST_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/yandex-gateway/artist_tracks_handler  kArtistTracksHandlerSchema  YANDEX_GATEWAY_ARTIST_TRACKS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/yandex-gateway/readiness_handler      kYandexGatewayReadinessHandlerSchema YANDEX_GATEWAY_READINESS_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_yandex_gateway_schema_headers DEPENDS
    ${YANDEX_GATEWAY_TRACK_ARTISTS_HANDLER_SCHEMA_HEADER}
    ${YANDEX_GATEWAY_SEARCH_ARTIST_HANDLER_SCHEMA_HEADER}
    ${YANDEX_GATEWAY_ARTIST_TRACKS_HANDLER_SCHEMA_HEADER}
    ${YANDEX_GATEWAY_READINESS_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat_yandex_gateway
    src/main.cpp
    src/internal/yandex/track_artists_handler.cpp
    src/internal/yandex/search_artist_handler.cpp
    src/internal/yandex/artist_tracks_handler.cpp
    src/system/readiness_handler.cpp
)

target_link_libraries(six_feat_yandex_gateway
    PRIVATE
        six_feat_core
        six_feat_yandex
        six_feat_http
)

target_include_directories(six_feat_yandex_gateway PRIVATE ${CMAKE_BINARY_DIR}/generated)

add_dependencies(six_feat_yandex_gateway six_feat_yandex_gateway_schema_headers)

six_feat_install_service(six_feat_yandex_gateway six_feat_yandex_gateway)
