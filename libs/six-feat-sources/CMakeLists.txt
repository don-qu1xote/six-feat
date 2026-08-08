include("${SIX_FEAT_ROOT}/cmake/EmbedSchema.cmake")

six_feat_embed_schema(components/genius_music_source_provider kGeniusMusicSourceProviderComponentSchema GENIUS_MUSIC_SOURCE_PROVIDER_COMPONENT_SCHEMA_HEADER)
six_feat_embed_schema(components/music_source_provider_chain  kMusicSourceProviderChainComponentSchema  MUSIC_SOURCE_PROVIDER_CHAIN_COMPONENT_SCHEMA_HEADER)

add_custom_target(six_feat_sources_schema_headers DEPENDS
    ${GENIUS_MUSIC_SOURCE_PROVIDER_COMPONENT_SCHEMA_HEADER}
    ${MUSIC_SOURCE_PROVIDER_CHAIN_COMPONENT_SCHEMA_HEADER}
)

add_library(six_feat_sources STATIC
    src/genius_music_source_provider.cpp
    src/music_source_provider_chain.cpp
)

target_include_directories(six_feat_sources PUBLIC include)
target_include_directories(six_feat_sources PRIVATE ${CMAKE_BINARY_DIR}/generated)

target_link_libraries(six_feat_sources PUBLIC
    userver::core
    six_feat_domain
    six_feat_common
    six_feat_core
    six_feat_genius
)

add_dependencies(six_feat_sources six_feat_sources_schema_headers)
