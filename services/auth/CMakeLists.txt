# six-feat-auth — standalone OAuth-flow service (IDEA-53).
# Owns Genius's OAuth 2.0 Authorization Code Flow itself (/auth/login,
# /auth/callback, /auth/logout, /auth/me) plus PKCE (oauth-config.pkce-enabled).
#
# oauth_handler.cpp/session_crypto.cpp/health_handler.cpp now live in
# six_feat_core itself (see root CMakeLists.txt, src/shared/) instead of
# being compiled separately per target — six-feat needs the exact same OAuth
# code (same APP_SECRET-encrypted session cookie format, decrypted locally
# by six-feat's src/auth/token_router.hpp, no HTTP call between the two
# services), so it's shared code, not duplicated code.

add_executable(six_feat_auth
    main.cpp
)

target_link_libraries(six_feat_auth
    PRIVATE
        six_feat_core
        OpenSSL::Crypto
)

install(TARGETS six_feat_auth DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_auth)
