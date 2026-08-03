cmake_minimum_required(VERSION 3.22)
project(six_feat_game_service CXX)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/presets/service.cmake)
six_feat_init_service()

six_feat_embed_schema(handlers/game/readiness_handler kGameReadinessHandlerSchema GAME_READINESS_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(components/game_store kGameStoreComponentSchema GAME_STORE_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(handlers/game/profile_handler kGameProfileHandlerSchema GAME_PROFILE_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(components/neighbours_client kNeighboursClientComponentSchema NEIGHBOURS_CLIENT_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(handlers/game/validate_handler kGameValidateHandlerSchema GAME_VALIDATE_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/game/submit_handler kGameSubmitHandlerSchema GAME_SUBMIT_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/game/challenge_handler kGameChallengeHandlerSchema GAME_CHALLENGE_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(components/daily_challenge_task kDailyChallengeTaskComponentSchema DAILY_CHALLENGE_TASK_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(handlers/game/leaderboard_handler kGameLeaderboardHandlerSchema GAME_LEADERBOARD_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/game/link_handler kGameLinkHandlerSchema GAME_LINK_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/game/challenges_handler kGameChallengesHandlerSchema GAME_CHALLENGES_HANDLER_SCHEMA_HEADER)
six_feat_embed_schema(handlers/game/season_handler kGameSeasonHandlerSchema GAME_SEASON_HANDLER_SCHEMA_HEADER)
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
    src/core/game_store.cpp
    src/core/ideal_finder.hpp
    src/core/chain_validator.hpp
    src/infrastructure/neighbours_client.cpp
    src/scheduler/daily_challenge_task.cpp
    src/system/readiness_handler.cpp
    src/api/v1/game/admin_handler.cpp
    src/api/v1/game/challenge_handler.cpp
    src/api/v1/game/challenges_handler.cpp
    src/api/v1/game/leaderboard_handler.cpp
    src/api/v1/game/link_handler.cpp
    src/api/v1/game/profile_handler.cpp
    src/api/v1/game/season_handler.cpp
    src/api/v1/game/submit_handler.cpp
    src/api/v1/game/validate_handler.cpp
)

target_link_libraries(six_feat_game
    PRIVATE
        six_feat_core
        six_feat_auth_lib
        six_feat_http
        OpenSSL::Crypto
)

target_include_directories(six_feat_game PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_BINARY_DIR}/generated
)

add_dependencies(six_feat_game six_feat_game_schema_headers)

six_feat_install_service(six_feat_game six_feat_game)
