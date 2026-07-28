cmake_minimum_required(VERSION 3.22)
project(six_feat_game_service CXX)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/presets/service.cmake)
six_feat_init_service()

# [SF-INF-03] Unified readiness contract — see internal_handlers.hpp's
# ReadinessHandler doc-comment.
six_feat_embed_schema(handlers/game/readiness_handler kGameReadinessHandlerSchema GAME_READINESS_HANDLER_SCHEMA_HEADER)
# [SF-GAME-11] game-store component config schema (dbname).
six_feat_embed_schema(components/game_store kGameStoreComponentSchema GAME_STORE_COMPONENT_SCHEMA_HEADER)
# [SF-GAME-12] profile handler config schema.
six_feat_embed_schema(handlers/game/profile_handler kGameProfileHandlerSchema GAME_PROFILE_HANDLER_SCHEMA_HEADER)
# [SF-GAME-13] Anti-cheat neighbours-lookup client config schema.
six_feat_embed_schema(components/neighbours_client kNeighboursClientComponentSchema NEIGHBOURS_CLIENT_COMPONENT_SCHEMA_HEADER)
# [SF-GAME-14] Chain-validation handler config schema.
six_feat_embed_schema(handlers/game/validate_handler kGameValidateHandlerSchema GAME_VALIDATE_HANDLER_SCHEMA_HEADER)
# [SF-GAME-15] Submission (scoring + Elo) handler config schema.
six_feat_embed_schema(handlers/game/submit_handler kGameSubmitHandlerSchema GAME_SUBMIT_HANDLER_SCHEMA_HEADER)
# [SF-GAME-16] Challenge create/get handler + daily-challenge task schemas.
six_feat_embed_schema(handlers/game/challenge_handler kGameChallengeHandlerSchema GAME_CHALLENGE_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(components/daily_challenge_task kDailyChallengeTaskComponentSchema DAILY_CHALLENGE_TASK_COMPONENT_SCHEMA_HEADER)
# [SF-GAME-17] Leaderboard handler config schema. (SubmitHandler's new
# rate-limit dependency, RateLimitStoreComponent, is six_feat_common's own
# component — its schema is already embedded there, no new line needed here.)
six_feat_embed_schema(handlers/game/leaderboard_handler kGameLeaderboardHandlerSchema GAME_LEADERBOARD_HANDLER_SCHEMA_HEADER)
# [game #2] Live per-hop connection-check handler config schema.
six_feat_embed_schema(handlers/game/link_handler kGameLinkHandlerSchema GAME_LINK_HANDLER_SCHEMA_HEADER)
# [game #3] Challenge-browser listing handler config schema.
six_feat_embed_schema(handlers/game/challenges_handler kGameChallengesHandlerSchema GAME_CHALLENGES_HANDLER_SCHEMA_HEADER)
# [game #4] Season & achievements hub handler config schema.
six_feat_embed_schema(handlers/game/season_handler kGameSeasonHandlerSchema GAME_SEASON_HANDLER_SCHEMA_HEADER)
# [admin] Owner-gated admin handler config schema (admin-user-ids allowlist).
six_feat_embed_schema(handlers/game/admin_handler kGameAdminHandlerSchema GAME_ADMIN_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_game_schema_headers DEPENDS
    ${GAME_READINESS_HANDLER_SCHEMA_HEADER}
    ${GAME_STORE_COMPONENT_SCHEMA_HEADER}
    ${GAME_PROFILE_HANDLER_SCHEMA_HEADER}
    ${NEIGHBOURS_CLIENT_COMPONENT_SCHEMA_HEADER}
    ${GAME_VALIDATE_HANDLER_SCHEMA_HEADER}
    ${GAME_SUBMIT_HANDLER_SCHEMA_HEADER}
    ${GAME_CHALLENGE_HANDLER_SCHEMA_HEADER}
    ${DAILY_CHALLENGE_TASK_COMPONENT_SCHEMA_HEADER}
    ${GAME_LEADERBOARD_HANDLER_SCHEMA_HEADER}
    ${GAME_LINK_HANDLER_SCHEMA_HEADER}
    ${GAME_CHALLENGES_HANDLER_SCHEMA_HEADER}
    ${GAME_SEASON_HANDLER_SCHEMA_HEADER}
    ${GAME_ADMIN_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat_game
    src/main.cpp
    src/internal_handlers.cpp
    src/game_store.cpp
    src/profile_handler.cpp
    src/neighbours_client.cpp
    src/validate_handler.cpp
    src/submit_handler.cpp
    src/challenge_handler.cpp
    src/daily_challenge_task.cpp
    src/leaderboard_handler.cpp
    src/link_handler.cpp
    src/challenges_handler.cpp
    src/season_handler.cpp
    src/admin_handler.cpp
)

target_link_libraries(six_feat_game
    PRIVATE
        six_feat_core
        six_feat_auth_lib
        six_feat_http
        OpenSSL::Crypto
)

target_include_directories(six_feat_game PRIVATE ${CMAKE_BINARY_DIR}/generated)

add_dependencies(six_feat_game six_feat_game_schema_headers)

six_feat_install_service(six_feat_game six_feat_game)
