cmake_minimum_required(VERSION 3.22)
project(six_feat_unit_tests CXX)

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

# Юнит-тестами на C++ проверяется ровно то, до чего не дотягивается ручка:
# средний цвет фотографии считается из байтов картинки, и HTTP-тест видит
# только итоговый hex, а не поведение алгоритма на прозрачности и на размерах,
# не кратных сетке. Разбор путей, резолв артиста и роли рёбер проверяются
# сквозь /api/v1/graph и /api/v1/graph/path (tests/test_graph.py,
# tests/test_path.py) — дублировать их ещё и здесь было незачем.
add_executable(six_feat_unit_tests
  ${SIX_FEAT_ROOT}/libs/six-feat-image/src/dominant_color.cpp
  test_dominant_color.cpp
)

target_include_directories(six_feat_unit_tests PRIVATE
  ${SIX_FEAT_ROOT}/libs/six-feat-image/include
  ${SIX_FEAT_ROOT}/libs/six-feat-image/vendor
  ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(six_feat_unit_tests PRIVATE GTest::gtest_main)

include(GoogleTest)
gtest_discover_tests(six_feat_unit_tests)
