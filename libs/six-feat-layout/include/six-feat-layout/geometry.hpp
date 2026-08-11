#pragma once

#include <cmath>
#include <cstdint>
#include <vector>

namespace six_feat::layout {

struct Point {
  double x{0.0};
  double y{0.0};
};

/// Контур одной группы: узел-хаб, вокруг чьих подопечных он обведён, и точки.
///
/// Точки, а не строка SVG-пути, — по трём причинам, все со стороны клиента.
/// Клиент кэширует контуры в offscreen-битмапе и для этого считает их bbox, а
/// bbox из строки не достать, не разобрав её обратно в числа. Path2D с
/// SVG-данными есть не во всяком окружении, где этот код исполняется, — в
/// jsdom под vitest его нет. И массив чисел в JSON дешевле и собрать, и
/// разобрать, чем ту же геометрию, склеенную в строку. Сглаживание (кривые
/// через середины рёбер) остаётся у клиента: это способ обвести данные точки,
/// а не отдельная геометрия.
struct Contour {
  std::int64_t hub{0};
  std::vector<Point> points;
};

/// Math.hypot из V8, повторённый до последнего бита.
///
/// std::hypot в glibc и Math.hypot в V8 расходятся в последнем ulp примерно на
/// трети входов. Раскладка и контуры считались раньше в браузере, эталонные
/// координаты сняты оттуда же, поэтому длина вектора здесь считается тем же
/// алгоритмом (нормировка на максимум плюс компенсированное суммирование), а
/// не библиотечным.
inline double Hypot(double a, double b) {
  const double ax = std::fabs(a);
  const double ay = std::fabs(b);
  const double max = ax > ay ? ax : ay;
  if (max == 0.0) return 0.0;
  double sum = 0.0;
  double comp = 0.0;
  for (const double v : {ax, ay}) {
    const double n = v / max;
    const double summand = n * n - comp;
    const double prelim = sum + summand;
    comp = (prelim - sum) - summand;
    sum = prelim;
  }
  return std::sqrt(sum) * max;
}

}  // namespace six_feat::layout
