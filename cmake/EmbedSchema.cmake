# six_feat_embed_schema(<schema-path> <const-name> <out-var>)
#
# Embeds schemas/<schema-path>.yaml (relative to the repo root, e.g.
# "handlers/six-feat/graph_handler" or "components/persistent_store") as a
# generated C++ header at build time:
#
#   generated/schemas/<schema-path>_schema.hpp
#   constexpr const char* <const-name> = R"(...)";
#
# so GetStaticConfigSchema() implementations can #include the header instead
# of carrying the YAML inline. The generated header path is written into
# <out-var> in the caller's scope. Regenerates automatically whenever the
# source .yaml file changes (see cmake/GenerateSchemaHeader.cmake).
function(six_feat_embed_schema HANDLER_NAME CONST_NAME OUT_VAR)
    set(schema_yaml "${SIX_FEAT_ROOT}/schemas/${HANDLER_NAME}.yaml")
    set(output_header "${CMAKE_BINARY_DIR}/generated/schemas/${HANDLER_NAME}_schema.hpp")

    # Generate the header eagerly at configure time as well, not only at build
    # time. Tooling that only *configures* the project without building it —
    # notably the CI clang-tidy job, which runs `cmake -S ... -B build` purely
    # to emit compile_commands.json and then parses the sources directly, never
    # running `cmake --build` — needs these generated headers to already exist
    # on disk. Otherwise every handler translation unit that #includes one
    # fails to parse with "'schemas/.../<name>_schema.hpp' file not found", a
    # clang-diagnostic error that makes the whole clang-tidy run exit non-zero.
    # GenerateSchemaHeader.cmake uses configure_file(), which only rewrites the
    # output when the embedded YAML actually changed, so re-running it here is
    # idempotent and introduces no spurious rebuilds. The add_custom_command
    # below still owns dependency-tracked regeneration during a normal build.
    execute_process(
        COMMAND "${CMAKE_COMMAND}"
                "-DSCHEMA_YAML=${schema_yaml}"
                "-DOUTPUT_HEADER=${output_header}"
                "-DCONST_NAME=${CONST_NAME}"
                -P "${SIX_FEAT_ROOT}/cmake/GenerateSchemaHeader.cmake"
        RESULT_VARIABLE _six_feat_embed_schema_result
    )
    if(NOT _six_feat_embed_schema_result EQUAL "0")
        message(FATAL_ERROR
            "six_feat_embed_schema: configure-time generation of "
            "${output_header} failed (${_six_feat_embed_schema_result})")
    endif()

    add_custom_command(
        OUTPUT "${output_header}"
        COMMAND "${CMAKE_COMMAND}"
                "-DSCHEMA_YAML=${schema_yaml}"
                "-DOUTPUT_HEADER=${output_header}"
                "-DCONST_NAME=${CONST_NAME}"
                -P "${SIX_FEAT_ROOT}/cmake/GenerateSchemaHeader.cmake"
        DEPENDS
            "${schema_yaml}"
            "${SIX_FEAT_ROOT}/cmake/GenerateSchemaHeader.cmake"
            "${SIX_FEAT_ROOT}/cmake/schema_header.hpp.in"
        COMMENT "Embedding schemas/${HANDLER_NAME}.yaml -> generated/schemas/${HANDLER_NAME}_schema.hpp"
        VERBATIM
    )

    set(${OUT_VAR} "${output_header}" PARENT_SCOPE)
endfunction()
