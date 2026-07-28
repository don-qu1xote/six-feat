include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(components/rate_limit_store kRateLimitStoreComponentSchema RATE_LIMIT_STORE_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_core_schema_headers DEPENDS ${RATE_LIMIT_STORE_COMPONENT_SCHEMA_HEADER})

add_library(six_feat_core STATIC
    src/resilience.cpp
    src/rate_limit_store.cpp
    src/rate_limit_store_postgres.cpp
    src/rate_limit_store_component.cpp
    src/request_id.cpp
    src/http_cache.cpp
    src/security_headers.cpp
    src/internal_auth.cpp
    src/internal_http.cpp
    src/error_response.cpp
)

target_include_directories(six_feat_core PUBLIC include)
target_include_directories(six_feat_core PRIVATE ${CMAKE_BINARY_DIR}/generated)

target_link_libraries(six_feat_core PUBLIC
    userver::core
    userver::postgresql
    OpenSSL::Crypto
)

add_dependencies(six_feat_core six_feat_core_schema_headers)
