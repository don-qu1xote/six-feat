include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(handlers/shared/health_handler kHealthHandlerSchema HEALTH_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_http_schema_headers DEPENDS ${HEALTH_HANDLER_SCHEMA_HEADER})

add_library(six_feat_http STATIC
    src/health_handler.cpp
    src/readiness_common.cpp
)

target_include_directories(six_feat_http PUBLIC include)
target_include_directories(six_feat_http PRIVATE ${CMAKE_BINARY_DIR}/generated)

target_link_libraries(six_feat_http PUBLIC
    userver::core
    six_feat_core
)

add_dependencies(six_feat_http six_feat_http_schema_headers)
