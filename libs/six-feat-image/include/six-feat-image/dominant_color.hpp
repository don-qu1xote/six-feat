#pragma once

#include <cstddef>
#include <optional>
#include <string>

namespace six_feat::image {

// [SF-API-20] Сторона сетки, до которой изображение ужимается перед
// усреднением. Двенадцать — не «достаточно мало», а ровно то число, что
// стояло в front/src/vis-adapter/photo-color.js (SAMPLE_SIZE): счёт переезжает
// на сервер, а цвета обязаны остаться прежними.
inline constexpr int kSampleSize = 12;

// Пиксели прозрачнее этого порога в среднее не идут — та же граница, что была
// на клиенте (data[i + 3] < 16 → continue). Нужна для PNG с прозрачным фоном:
// иначе средний цвет тянет к чёрному по невидимым пикселям.
inline constexpr int kMinAlpha = 16;

// Средний цвет изображения в виде "#rrggbb".
// std::nullopt — законный ответ, а не ошибка: не картинка, битые байты,
// формат, который не декодируется, или вообще ни одного пикселя непрозрачнее
// kMinAlpha. Вызывающий в таком случае просто не сохраняет цвет — колонка
// остаётся NULL, а клиент рисует роль-цвет, как рисовал до загрузки фото.
std::optional<std::string> DominantColorHex(const void* bytes, std::size_t size);

}  // namespace six_feat::image
