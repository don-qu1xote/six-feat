include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(components/persistent_store  kPersistentStoreComponentSchema  PERSISTENT_STORE_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/artist_repository kArtistRepositoryComponentSchema ARTIST_REPOSITORY_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_storage_schema_headers DEPENDS
    ${PERSISTENT_STORE_COMPONENT_SCHEMA_HEADER}
    ${ARTIST_REPOSITORY_COMPONENT_SCHEMA_HEADER}
)

add_library(six_feat_storage STATIC
    src/persistent_store.cpp
    src/artist_repository.cpp
    src/analytics.cpp
)

target_include_directories(six_feat_storage PUBLIC include)
target_include_directories(six_feat_storage PRIVATE ${CMAKE_BINARY_DIR}/generated)

target_link_libraries(six_feat_storage PUBLIC
    userver::core
    userver::postgresql
    six_feat_domain
    six_feat_core
    six_feat_common
)

add_dependencies(six_feat_storage six_feat_storage_schema_headers)
