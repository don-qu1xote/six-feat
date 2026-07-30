cmake_minimum_required(VERSION 3.22)
project(six_feat_service CXX)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/presets/service.cmake)
six_feat_init_service()

six_feat_embed_schema(handlers/six-feat/artist_handler     kArtistHandlerSchema    ARTIST_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/api_keys_issue_handler  kApiKeysIssueHandlerSchema  API_KEYS_ISSUE_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/api_keys_revoke_handler kApiKeysRevokeHandlerSchema API_KEYS_REVOKE_HANDLER_SCHEMA_HEADER)
# [SF-YM-02] Настройки: BYO Genius токен + личный Яндекс device flow.
six_feat_embed_schema(handlers/six-feat/settings_status_handler             kSettingsStatusHandlerSchema             SETTINGS_STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/settings_genius_connect_handler     kSettingsGeniusConnectHandlerSchema      SETTINGS_GENIUS_CONNECT_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/settings_disconnect_handler        kSettingsDisconnectHandlerSchema         SETTINGS_DISCONNECT_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/settings_yandex_device_start_handler kSettingsYandexDeviceStartHandlerSchema SETTINGS_YANDEX_DEVICE_START_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/settings_yandex_device_poll_handler  kSettingsYandexDevicePollHandlerSchema  SETTINGS_YANDEX_DEVICE_POLL_HANDLER_SCHEMA_HEADER)
# [SF-YM-04] Импорт плейлистов/лайков — потребление seed-подсказок.
six_feat_embed_schema(handlers/six-feat/settings_yandex_playlists_handler   kSettingsYandexPlaylistsHandlerSchema    SETTINGS_YANDEX_PLAYLISTS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/settings_yandex_import_handler      kSettingsYandexImportHandlerSchema       SETTINGS_YANDEX_IMPORT_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/graph_handler      kGraphHandlerSchema     GRAPH_HANDLER_SCHEMA_HEADER)
# [SF-YM-03] Углубление графа через Genius по запросу.
six_feat_embed_schema(handlers/six-feat/graph_deepen_handler kGraphDeepenHandlerSchema GRAPH_DEEPEN_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/path_handler       kPathHandlerSchema      PATH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/search_handler     kSearchHandlerSchema    SEARCH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/status_handler     kStatusHandlerSchema    STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/sse_status_handler kSseStatusHandlerSchema SSE_STATUS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/readiness_handler  kReadinessHandlerSchema READINESS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/static_handler     kStaticHandlerSchema    STATIC_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/six-feat/image_proxy_handler kImageProxyHandlerSchema IMAGE_PROXY_HANDLER_SCHEMA_HEADER)
# [SF-GAME-13] Internal-mesh anti-cheat neighbours lookup.
six_feat_embed_schema(handlers/six-feat/internal_neighbours_handler kInternalNeighboursHandlerSchema INTERNAL_NEIGHBOURS_HANDLER_SCHEMA_HEADER)
# Internal-mesh тестовый/seam для MusicSourceProviderChain.
six_feat_embed_schema(handlers/six-feat/music_source_edges_handler kMusicSourceEdgesHandlerSchema MUSIC_SOURCE_EDGES_HANDLER_SCHEMA_HEADER)

six_feat_embed_schema(components/enrichment_client         kEnrichmentClientComponentSchema         ENRICHMENT_CLIENT_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/collab_service            kCollabServiceComponentSchema            COLLAB_SERVICE_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/app_secret_parity_checker kAppSecretParityCheckerComponentSchema   APP_SECRET_PARITY_CHECKER_COMPONENT_SCHEMA_HEADER)
# MusicSourceProvider: Yandex (дефолт) + Genius (углубление/fallback).
six_feat_embed_schema(components/yandex_music_source_provider kYandexMusicSourceProviderComponentSchema YANDEX_MUSIC_SOURCE_PROVIDER_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/genius_music_source_provider kGeniusMusicSourceProviderComponentSchema GENIUS_MUSIC_SOURCE_PROVIDER_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/music_source_provider_chain   kMusicSourceProviderChainComponentSchema   MUSIC_SOURCE_PROVIDER_CHAIN_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_sixfeat_schema_headers DEPENDS
    ${ARTIST_HANDLER_SCHEMA_HEADER}
    ${API_KEYS_ISSUE_HANDLER_SCHEMA_HEADER}
    ${API_KEYS_REVOKE_HANDLER_SCHEMA_HEADER}
    ${SETTINGS_STATUS_HANDLER_SCHEMA_HEADER}
    ${SETTINGS_GENIUS_CONNECT_HANDLER_SCHEMA_HEADER}
    ${SETTINGS_DISCONNECT_HANDLER_SCHEMA_HEADER}
    ${SETTINGS_YANDEX_DEVICE_START_HANDLER_SCHEMA_HEADER}
    ${SETTINGS_YANDEX_DEVICE_POLL_HANDLER_SCHEMA_HEADER}
    ${SETTINGS_YANDEX_PLAYLISTS_HANDLER_SCHEMA_HEADER}
    ${SETTINGS_YANDEX_IMPORT_HANDLER_SCHEMA_HEADER}
    ${GRAPH_HANDLER_SCHEMA_HEADER}
    ${GRAPH_DEEPEN_HANDLER_SCHEMA_HEADER}
    ${PATH_HANDLER_SCHEMA_HEADER}
    ${SEARCH_HANDLER_SCHEMA_HEADER}
    ${STATUS_HANDLER_SCHEMA_HEADER}
    ${SSE_STATUS_HANDLER_SCHEMA_HEADER}
    ${READINESS_HANDLER_SCHEMA_HEADER}
    ${STATIC_HANDLER_SCHEMA_HEADER}
    ${IMAGE_PROXY_HANDLER_SCHEMA_HEADER}
    ${INTERNAL_NEIGHBOURS_HANDLER_SCHEMA_HEADER}
    ${MUSIC_SOURCE_EDGES_HANDLER_SCHEMA_HEADER}
    ${ENRICHMENT_CLIENT_COMPONENT_SCHEMA_HEADER}
    ${COLLAB_SERVICE_COMPONENT_SCHEMA_HEADER}
    ${APP_SECRET_PARITY_CHECKER_COMPONENT_SCHEMA_HEADER}
    ${YANDEX_MUSIC_SOURCE_PROVIDER_COMPONENT_SCHEMA_HEADER}
    ${GENIUS_MUSIC_SOURCE_PROVIDER_COMPONENT_SCHEMA_HEADER}
    ${MUSIC_SOURCE_PROVIDER_CHAIN_COMPONENT_SCHEMA_HEADER}
)

add_executable(six_feat
    src/main.cpp
    src/infrastructure/genius_error_mapping.cpp
    src/infrastructure/enrichment_client.cpp
    src/infrastructure/yandex_music_source_provider.cpp
    src/infrastructure/genius_music_source_provider.cpp
    src/infrastructure/music_source_provider_chain.cpp
    src/application/artist_resolver.cpp
    src/application/collab_service.cpp
    src/auth/app_secret_parity_checker.cpp
    src/http/dto/artist_ref_dto.cpp
    src/http/dto/candidate_dto.cpp
    src/http/dto/edge_source_dto.cpp
    src/http/dto/graph_edge_dto.cpp
    src/http/dto/path_edge_dto.cpp
    src/auth/api_key_auth.cpp
    src/api/v1/artist_handler.cpp
    src/api/v1/api_keys_handler.cpp
    src/api/v1/settings_handler.cpp
    src/api/v1/graph_handler.cpp
    src/api/v1/graph_deepen_handler.cpp
    src/api/v1/path_handler.cpp
    src/api/v1/search_handler.cpp
    src/api/v1/status_handler.cpp
    src/api/v1/static_handler.cpp
    src/api/v1/sse_status_handler.cpp
    src/api/v1/image_proxy_handler.cpp
    src/internal/neighbours_handler.cpp
    src/internal/music_source_edges_handler.cpp
    src/system/readiness_handler.cpp
)

target_include_directories(six_feat PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_BINARY_DIR}/generated
)

target_link_libraries(six_feat
    PRIVATE
        six_feat_domain
        six_feat_common
        six_feat_core
        six_feat_storage
        six_feat_genius
        six_feat_yandex
        six_feat_enrichment
        six_feat_auth_lib
        six_feat_http
        OpenSSL::Crypto
)

add_dependencies(six_feat six_feat_sixfeat_schema_headers)

six_feat_install_service(six_feat six_feat)
