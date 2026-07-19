# six-feat-game — competitive "connect two artists" game service (SF-GAME-10),
# standalone CMake project. Build standalone: cd services/game && cmake -S . -B build
#
# Modeled on services/auth/CMakeLists.txt: reuses six_feat_common (health/
# readiness handlers, the internal-mesh secret, request-id/security-headers)
# rather than duplicating that code. userver postgresql is found (via
# six_feat_common) so SF-GAME-11 can add the store without a CMake change;
# OpenSSL is linked because six_feat_common exposes it PUBLIC and SF-GAME-12
# will decrypt the six_feat_session cookie with the same session_crypto.

cmake_minimum_required(VERSION 3.22)
project(six_feat_game_service CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

get_filename_component(SIX_FEAT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

find_package(userver COMPONENTS core postgresql REQUIRED)
find_package(OpenSSL REQUIRED)

if(NOT TARGET six_feat_common)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-common" "${CMAKE_BINARY_DIR}/six-feat-common")
endif()

include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

# [SF-INF-03] Unified readiness contract — see internal_handlers.hpp's
# ReadinessHandler doc-comment.
six_feat_embed_schema(handlers/game/readiness_handler kGameReadinessHandlerSchema GAME_READINESS_HANDLER_SCHEMA_HEADER)
# [SF-GAME-11] game-store component config schema (dbname).
six_feat_embed_schema(components/game_store kGameStoreComponentSchema GAME_STORE_COMPONENT_SCHEMA_HEADER)
# [SF-GAME-12] profile handler config schema.
six_feat_embed_schema(handlers/game/profile_handler kGameProfileHandlerSchema GAME_PROFILE_HANDLER_SCHEMA_HEADER)

add_custom_target(six_feat_game_schema_headers DEPENDS
    ${GAME_READINESS_HANDLER_SCHEMA_HEADER}
    ${GAME_STORE_COMPONENT_SCHEMA_HEADER}
    ${GAME_PROFILE_HANDLER_SCHEMA_HEADER}
)

add_executable(six_feat_game
    main.cpp
    internal_handlers.cpp
    game_store.cpp
    profile_handler.cpp
)

target_link_libraries(six_feat_game
    PRIVATE
        six_feat_common
        OpenSSL::Crypto
)

add_dependencies(six_feat_game six_feat_game_schema_headers)

install(TARGETS six_feat_game DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_game)
