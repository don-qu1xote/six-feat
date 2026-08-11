# Сигнатура: six_feat_embed_schema(<schema-path> <const-name> <out-var>)
#
# Встраивает schemas/<schema-path>.yaml (относительно корня репозитория,
# например "handlers/six-feat/graph_handler" или "components/persistent_store")
# в генерируемый C++-заголовок на этапе сборки, например:
#
#   путь заголовка: generated/schemas/<schema-path>_schema.hpp
#   содержимое:     constexpr const char* <const-name> = R"(...)";
#
# чтобы реализации GetStaticConfigSchema() делали #include заголовка, а не
# носили YAML инлайном. Путь к сгенерированному заголовку пишется в <out-var>
# в scope вызывающего. Перегенерируется автоматически при изменении исходного
# .yaml-файла (см. cmake/GenerateSchemaHeader.cmake).
function(six_feat_embed_schema HANDLER_NAME CONST_NAME OUT_VAR)
    set(schema_yaml "${SIX_FEAT_ROOT}/schemas/${HANDLER_NAME}.yaml")
    set(output_header "${CMAKE_BINARY_DIR}/generated/schemas/${HANDLER_NAME}_schema.hpp")

    # Генерируем заголовок сразу и на этапе конфигурации, а не только при
    # сборке. Инструменты, которые проект только *конфигурируют*, но не
    # собирают — в первую очередь CI-джоба clang-tidy, которая запускает
    # `cmake -S ... -B build` лишь ради compile_commands.json и потом читает
    # сорцы напрямую, не выполняя `cmake --build` — требуют, чтобы
    # сгенерированные заголовки уже лежали на диске. Иначе каждая единица
    # трансляции хендлера с #include падает с "'schemas/.../<name>_schema.hpp'
    # file not found" — clang-diagnostic ошибкой, из-за которой весь прогон
    # clang-tidy уходит в ненулевой код.
    # GenerateSchemaHeader.cmake использует configure_file(), который
    # переписывает вывод только когда встроенный YAML реально изменился,
    # так что повторный запуск идемпотентен и не плодит ложных пересборок.
    # add_custom_command ниже по-прежнему владеет перегенерацией с трекингом
    # зависимостей во время обычной сборки.
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