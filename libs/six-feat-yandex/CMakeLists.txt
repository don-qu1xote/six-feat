include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(components/yandex_music_gateway      kYandexMusicGatewayComponentSchema     YANDEX_MUSIC_GATEWAY_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/yandex_gateway_client     kYandexGatewayClientComponentSchema    YANDEX_GATEWAY_CLIENT_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_yandex_schema_headers DEPENDS
    ${YANDEX_MUSIC_GATEWAY_COMPONENT_SCHEMA_HEADER}
    ${YANDEX_GATEWAY_CLIENT_COMPONENT_SCHEMA_HEADER}
)

add_library(six_feat_yandex STATIC
    src/yandex_music_gateway.cpp
    src/yandex_gateway_client.cpp
)

target_include_directories(six_feat_yandex PUBLIC include)
target_include_directories(six_feat_yandex PRIVATE ${CMAKE_BINARY_DIR}/generated)

target_link_libraries(six_feat_yandex PUBLIC
    userver::core
    six_feat_domain
    six_feat_core
)

add_dependencies(six_feat_yandex six_feat_yandex_schema_headers)
