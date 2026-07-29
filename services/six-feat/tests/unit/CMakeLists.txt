cmake_minimum_required(VERSION 3.22)
project(six_feat_unit_tests CXX)

# Независимый CMake-проект без find_package(userver) — компилирует чистые
# .cpp напрямую (analytics.cpp, music_source_provider.cpp, artist_resolver.cpp),
# вместо link на userver-зависимые libs/* таргеты. Нижний слой пирамиды тестов:
# без userver, без Postgres, без бинарника сервиса.

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

get_filename_component(SIX_FEAT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../.." ABSOLUTE)

include(FetchContent)
FetchContent_Declare(
  googletest
  URL https://github.com/google/googletest/archive/refs/tags/v1.15.2.zip
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

enable_testing()

add_executable(six_feat_unit_tests
  ${SIX_FEAT_ROOT}/libs/six-feat-storage/src/analytics.cpp
  ${SIX_FEAT_ROOT}/libs/six-feat-common/src/music_source_provider.cpp
  ${SIX_FEAT_ROOT}/services/six-feat/src/application/artist_resolver.cpp
  test_artist_resolver.cpp
  test_bidirectional_bfs.cpp
  test_music_source_provider_chain.cpp
)

target_include_directories(six_feat_unit_tests PRIVATE
  ${SIX_FEAT_ROOT}/libs/six-feat-domain/include
  ${SIX_FEAT_ROOT}/libs/six-feat-storage/include
  ${SIX_FEAT_ROOT}/libs/six-feat-genius/include
  ${SIX_FEAT_ROOT}/libs/six-feat-common/include
  ${SIX_FEAT_ROOT}/libs/six-feat-core/include
  ${SIX_FEAT_ROOT}/services/six-feat/src
  ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(six_feat_unit_tests PRIVATE GTest::gtest_main)

include(GoogleTest)
gtest_discover_tests(six_feat_unit_tests)
