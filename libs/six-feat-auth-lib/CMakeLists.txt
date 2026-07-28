include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(handlers/shared/oauth_handler kOAuthHandlerSchema OAUTH_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_auth_lib_schema_headers DEPENDS ${OAUTH_HANDLER_SCHEMA_HEADER})

add_library(six_feat_auth_lib STATIC
    src/oauth_handler.cpp
    src/session_crypto.cpp
)

target_include_directories(six_feat_auth_lib PUBLIC include)
target_include_directories(six_feat_auth_lib PRIVATE ${CMAKE_BINARY_DIR}/generated)

target_link_libraries(six_feat_auth_lib PUBLIC
    userver::core
    OpenSSL::Crypto
    six_feat_core
)

add_dependencies(six_feat_auth_lib six_feat_auth_lib_schema_headers)
