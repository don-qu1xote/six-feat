# six_feat_embed_schema(<handler-name> <const-name> <out-var>)
#
# Embeds schemas/handlers/<handler-name>.yaml (relative to the repo root,
# shared between the root CMakeLists.txt and services/enrichment/CMakeLists.txt)
# as a generated C++ header at build time:
#
#   generated/schemas/<handler-name>_schema.hpp
#   constexpr const char* <const-name> = R"(...)";
#
# so GetStaticConfigSchema() implementations can #include the header instead
# of carrying the YAML inline. The generated header path is written into
# <out-var> in the caller's scope. Regenerates automatically whenever the
# source .yaml file changes (see cmake/GenerateSchemaHeader.cmake).
function(six_feat_embed_schema HANDLER_NAME CONST_NAME OUT_VAR)
    set(schema_yaml "${CMAKE_SOURCE_DIR}/schemas/handlers/${HANDLER_NAME}.yaml")
    set(output_header "${CMAKE_BINARY_DIR}/generated/schemas/${HANDLER_NAME}_schema.hpp")

    add_custom_command(
        OUTPUT "${output_header}"
        COMMAND "${CMAKE_COMMAND}"
                "-DSCHEMA_YAML=${schema_yaml}"
                "-DOUTPUT_HEADER=${output_header}"
                "-DCONST_NAME=${CONST_NAME}"
                -P "${CMAKE_SOURCE_DIR}/cmake/GenerateSchemaHeader.cmake"
        DEPENDS
            "${schema_yaml}"
            "${CMAKE_SOURCE_DIR}/cmake/GenerateSchemaHeader.cmake"
            "${CMAKE_SOURCE_DIR}/cmake/schema_header.hpp.in"
        COMMENT "Embedding schemas/handlers/${HANDLER_NAME}.yaml -> generated/schemas/${HANDLER_NAME}_schema.hpp"
        VERBATIM
    )

    set(${OUT_VAR} "${output_header}" PARENT_SCOPE)
endfunction()
