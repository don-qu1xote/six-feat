# [SF-API-20] Декодирование картинки и сведение её к одному цвету.
# vendor/stb_image.h — stb_image v2.30, public domain, взят как есть с
#   https://raw.githubusercontent.com/nothings/stb/master/stb_image.h
#   sha256 594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3
# Системной зависимости не появилось: заголовок собирается вместе с этой
# библиотекой, обновляется заменой файла целиком и локально не правится.
# Вендоренный stb_image (vendor/) виден только этой библиотеке: PRIVATE-путь
# не даёт STB_IMAGE_IMPLEMENTATION расползтись по другим единицам трансляции.
add_library(six_feat_image STATIC src/dominant_color.cpp)

target_include_directories(six_feat_image PUBLIC include)
target_include_directories(six_feat_image PRIVATE vendor)
