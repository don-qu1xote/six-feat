include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(handlers/shared/oauth_handler kOAuthHandlerSchema OAUTH_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(components/api_key_store kApiKeyStoreComponentSchema API_KEY_STORE_COMPONENT_SCHEMA_HEADER)
# [SF-YM-02] per-user connected Genius/Yandex токены.
six_feat_embed_schema(components/user_provider_token_store kUserProviderTokenStoreComponentSchema USER_PROVIDER_TOKEN_STORE_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_auth_lib_schema_headers DEPENDS
    ${OAUTH_HANDLER_SCHEMA_HEADER}
    ${API_KEY_STORE_COMPONENT_SCHEMA_HEADER}
    ${USER_PROVIDER_TOKEN_STORE_COMPONENT_SCHEMA_HEADER}
)

add_library(six_feat_auth_lib STATIC
    src/oauth_handler.cpp
    src/session_crypto.cpp
    src/api_key_store.cpp
    src/user_provider_token_store.cpp
)

target_include_directories(six_feat_auth_lib PUBLIC include)
target_include_directories(six_feat_auth_lib PRIVATE ${CMAKE_BINARY_DIR}/generated)

target_link_libraries(six_feat_auth_lib PUBLIC
    userver::core
    userver::postgresql
    OpenSSL::Crypto
    six_feat_core
)

add_dependencies(six_feat_auth_lib six_feat_auth_lib_schema_headers)
