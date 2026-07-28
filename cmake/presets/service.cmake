include_guard(GLOBAL)

# ── six_feat_init_service ────────────────────────────────────────────────────
# Инкапсулирует boilerplate, общий для всех сервисов:
#   - CMAKE_CXX_STANDARD 20
#   - SIX_FEAT_ROOT (относительно services/<name>/)
#   - find_package(userver / OpenSSL)
#   - add_subdirectory(libs/six-feat-common) если ещё не добавлен
#   - include(cmake/EmbedSchema.cmake)
#
# Вызывается ПОСЛЕ project() в каждом services/<name>/CMakeLists.txt.
# Устанавливает переменную SIX_FEAT_ROOT в вызывающей области видимости.
macro(six_feat_init_service)
  set(CMAKE_CXX_STANDARD 20)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)

  get_filename_component(SIX_FEAT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

  find_package(userver COMPONENTS core postgresql REQUIRED)
  find_package(OpenSSL REQUIRED)

  if(NOT TARGET six_feat_common)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-common"
                     "${CMAKE_BINARY_DIR}/six-feat-common")
  endif()

  include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")
endmacro()

# ── six_feat_install_service ─────────────────────────────────────────────────
# Единообразные install-правила для сервиса:
#   install(TARGETS <target> DESTINATION bin)
#   install(FILES static_config.yaml DESTINATION etc/<config_dir>)
macro(six_feat_install_service TARGET CONFIG_DIR)
  install(TARGETS ${TARGET} DESTINATION bin)
  install(FILES static_config.yaml DESTINATION etc/${CONFIG_DIR})
endmacro()
