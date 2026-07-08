# six-feat-auth — standalone OAuth-flow service (IDEA-53).
# Owns Genius's OAuth 2.0 Authorization Code Flow itself (/auth/login,
# /auth/callback, /auth/logout, /auth/me) plus PKCE (oauth-config.pkce-enabled).
#
# Links six_feat_core for request_id/security_headers only — unlike
# six-feat-enrichment/six-feat-genius-gateway it needs no Postgres, no
# GeniusGatewayClient. It compiles src/auth/oauth_handler.cpp and
# src/auth/session_crypto.cpp directly (same two translation units the main
# six_feat target also compiles — see root CMakeLists.txt) rather than
# duplicating OAuthConfig/LoginHandler/CallbackHandler/LogoutHandler/
# MeHandler: both binaries link the exact same OAuth code, encrypting
# sessions with the same APP_SECRET (session_crypto::KeyFromEnv()), so a
# cookie minted here is exactly what main's src/auth/token_router.hpp
# (RequireSession/ExtractToken) decrypts locally — no HTTP call between the
# two services on the per-request session-validation path.

add_executable(six_feat_auth
    main.cpp
    ${CMAKE_SOURCE_DIR}/src/auth/oauth_handler.cpp
    ${CMAKE_SOURCE_DIR}/src/auth/session_crypto.cpp
    ${CMAKE_SOURCE_DIR}/src/http/health_handler.cpp
)

target_link_libraries(six_feat_auth
    PRIVATE
        six_feat_core
        OpenSSL::Crypto
)

install(TARGETS six_feat_auth DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_auth)
