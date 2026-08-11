# [SF-API-21] Геометрия раскладки графа.
# Библиотека намеренно ничего не знает ни про userver, ни про HTTP, ни про
# домен: на вход — структура графа и два размера, на выходе — координаты.
# Именно поэтому её можно проверять юнит-тестами без графики и без сети,
# чего у прежней реализации во front/src/vis-adapter/layout.js не было.
add_library(six_feat_layout STATIC src/layout.cpp)

target_include_directories(six_feat_layout PUBLIC include)
