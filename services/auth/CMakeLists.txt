cmake_minimum_required(VERSION 3.22)
project(six_feat_auth_service CXX)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/presets/service.cmake)
six_feat_init_service()

six_feat_embed_schema(handlers/auth/key_fingerprint_handler kKeyFingerprintHandlerSchema AUTH_KEY_FINGERPRINT_HANDLER_SCHEMA_HEADER)
# [SF-INF-03] Unified readiness contract — see internal_handlers.hpp's
# ReadinessHandler doc-comment.
six_feat_embed_schema(handlers/auth/readiness_handler       kAuthReadinessHandlerSchema  AUTH_READINESS_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_auth_schema_headers DEPENDS
    ${AUTH_KEY_FINGERPRINT_HANDLER_SCHEMA_HEADER}
    ${AUTH_READINESS_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat_auth
    main.cpp
    internal_handlers.cpp
)

target_link_libraries(six_feat_auth
    PRIVATE
        six_feat_core
        six_feat_auth_lib
        six_feat_http
        OpenSSL::Crypto
)

target_include_directories(six_feat_auth PRIVATE ${CMAKE_BINARY_DIR}/generated)

add_dependencies(six_feat_auth six_feat_auth_schema_headers)

six_feat_install_service(six_feat_auth six_feat_auth)
