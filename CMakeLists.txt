cmake_minimum_required(VERSION 3.14)
project(six-feat CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# --- Getting userver -------------------------------------------------------
# Easiest: add userver as a git submodule and uncomment the next line.
#   git submodule add https://github.com/userver-framework/userver third_party/userver
# add_subdirectory(third_party/userver)
#
# Or, if userver is already installed on the system:
find_package(userver COMPONENTS core REQUIRED)
# ---------------------------------------------------------------------------

add_executable(${PROJECT_NAME}
    src/main.cpp
    src/graph_handler.cpp
    src/static_handler.cpp
)

target_include_directories(${PROJECT_NAME} PRIVATE src)
target_link_libraries(${PROJECT_NAME} PRIVATE userver::core)
