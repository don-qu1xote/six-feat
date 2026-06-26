cmake_minimum_required(VERSION 3.22)
project(six_feat CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── userver ──────────────────────────────────────────────────────────────────
# The ubuntu-22.04-userver image ships userver::core which already includes
# the HTTP client/server components. Listing "http" as a separate component
# causes CMake to look for userver-http-config.cmake which does not exist
# in this image variant → removed.
#
# If you switch to an image that DOES package http separately, restore:
#   find_package(userver COMPONENTS core http REQUIRED)
find_package(userver COMPONENTS core REQUIRED)

# ── SQLite3 ───────────────────────────────────────────────────────────────────
# Requires libsqlite3-dev installed in the build image.
# Added to Dockerfile: apt-get install -y libsqlite3-dev
find_package(SQLite3 REQUIRED)

# ── Sources ───────────────────────────────────────────────────────────────────
add_executable(six_feat
    src/role_mask.cpp
    src/resilience.cpp
    src/genius_gateway.cpp
    src/persistent_store.cpp
    src/artist_repository.cpp
    src/enrichment_queue.cpp
    src/enrichment_worker.cpp
    src/collab_service.cpp
    src/analytics.cpp
    src/graph_handler.cpp
    src/path_handler.cpp
    src/static_handler.cpp
    src/main.cpp
)

target_link_libraries(six_feat
    PRIVATE
        userver::core
        SQLite3::SQLite3
)

target_include_directories(six_feat
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}
)

# ── Install ───────────────────────────────────────────────────────────────────
install(TARGETS six_feat DESTINATION bin)
install(FILES static_config.yaml DESTINATION etc/six_feat)
