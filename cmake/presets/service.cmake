include_guard(GLOBAL)

# ── six_feat_init_service ────────────────────────────────────────────────────
# Инкапсулирует boilerplate, общий для всех сервисов:
#   - CMAKE_CXX_STANDARD 20
#   - SIX_FEAT_ROOT (относительно services/<name>/)
#   - find_package(userver / OpenSSL)
#   - add_subdirectory для всех libs/six-feat-* (7 библиотек)
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

  if(NOT TARGET six_feat_domain)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-domain"
                     "${CMAKE_BINARY_DIR}/six-feat-domain")
  endif()
  if(NOT TARGET six_feat_core)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-core"
                     "${CMAKE_BINARY_DIR}/six-feat-core")
  endif()
  if(NOT TARGET six_feat_storage)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-storage"
                     "${CMAKE_BINARY_DIR}/six-feat-storage")
  endif()
  if(NOT TARGET six_feat_genius)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-genius"
                     "${CMAKE_BINARY_DIR}/six-feat-genius")
  endif()
  if(NOT TARGET six_feat_yandex)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-yandex"
                     "${CMAKE_BINARY_DIR}/six-feat-yandex")
  endif()
  if(NOT TARGET six_feat_enrichment)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-enrichment"
                     "${CMAKE_BINARY_DIR}/six-feat-enrichment")
  endif()
  if(NOT TARGET six_feat_auth_lib)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-auth-lib"
                     "${CMAKE_BINARY_DIR}/six-feat-auth-lib")
  endif()
  if(NOT TARGET six_feat_http)
    add_subdirectory("${SIX_FEAT_ROOT}/libs/six-feat-http"
                     "${CMAKE_BINARY_DIR}/six-feat-http")
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
