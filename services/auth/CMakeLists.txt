# six-feat-auth — standalone OAuth-flow service (IDEA-53), standalone CMake
# project. Build standalone: cd services/auth && cmake -S . -B build
#
# oauth_handler.cpp/session_crypto.cpp/health_handler.cpp live in
# six_feat_common (libs/six-feat-common) — six-feat needs the exact same
# OAuth code (same APP_SECRET-encrypted session cookie format, decrypted
# locally by six-feat's services/six-feat/src/auth/token_router.hpp, no HTTP call between the
# two services), so it's shared code, not duplicated code.

cmake_minimum_required(VERSION 3.22)
project(six_feat_auth_service CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

get_filename_component(SIX_FEAT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

find_package(userver COMPONENTS core postgresql REQUIRED)
find_package(OpenSSL REQUIRED)

if(NOT TARGET six_feat_common)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-common" "${CMAKE_BINARY_DIR}/six-feat-common")
endif()

add_executable(six_feat_auth
    main.cpp
)

target_link_libraries(six_feat_auth
    PRIVATE
        six_feat_common
        OpenSSL::Crypto
)

install(TARGETS six_feat_auth DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat_auth)
