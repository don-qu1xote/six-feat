include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(components/genius_gateway        kGeniusGatewayComponentSchema        GENIUS_GATEWAY_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/genius_gateway_client kGeniusGatewayClientComponentSchema  GENIUS_GATEWAY_CLIENT_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_genius_schema_headers DEPENDS
    ${GENIUS_GATEWAY_COMPONENT_SCHEMA_HEADER}
    ${GENIUS_GATEWAY_CLIENT_COMPONENT_SCHEMA_HEADER}
)

add_library(six_feat_genius STATIC
    src/genius_gateway.cpp
    src/genius_gateway_client.cpp
)

target_include_directories(six_feat_genius PUBLIC include)
target_include_directories(six_feat_genius PRIVATE ${CMAKE_BINARY_DIR}/generated)

target_link_libraries(six_feat_genius PUBLIC
    userver::core
    six_feat_domain
    six_feat_core
)

add_dependencies(six_feat_genius six_feat_genius_schema_headers)
