# Скрипт-исполнитель на этапе сборки для six_feat_embed_schema() (см.
# EmbedSchema.cmake). Вызывается через `cmake -P` с параметрами
# -DSCHEMA_YAML=... -DOUTPUT_HEADER=... -DCONST_NAME=...
if(NOT DEFINED SCHEMA_YAML OR NOT DEFINED OUTPUT_HEADER OR NOT DEFINED CONST_NAME)
    message(FATAL_ERROR "GenerateSchemaHeader.cmake requires SCHEMA_YAML, OUTPUT_HEADER and CONST_NAME")
endif()

get_filename_component(script_dir "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)

file(READ "${SCHEMA_YAML}" SCHEMA_CONTENT)
configure_file("${script_dir}/schema_header.hpp.in" "${OUTPUT_HEADER}" @ONLY)
