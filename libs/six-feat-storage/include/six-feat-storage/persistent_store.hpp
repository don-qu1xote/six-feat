#pragma once

#include <cstdint>
#include <optional>
#include <six-feat-domain/domain_types.hpp>
#include <six-feat-storage/analytics.hpp>
#include <string>
#include <unordered_map>
#include <userver/components/component_base.hpp>
#include <userver/components/component_fwd.hpp>
#include <userver/engine/task/task_processor_fwd.hpp>
#include <userver/engine/task/task_with_result.hpp>
#include <userver/yaml_config/schema.hpp>
#include <vector>

namespace six_feat {

struct FetchState {
  Depth depth{Depth::kNone};
  int song_count{0};
  std::int64_t last_fetch_ts{0};
};

class PersistentStore final : public userver::components::ComponentBase {
 public:
  static constexpr std::string_view kName = "persistent-store";

  PersistentStore(const userver::components::ComponentConfig& config,
                  const userver::components::ComponentContext& context);

  ~PersistentStore() override;

  void OnAllComponentsLoaded() override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

  std::optional<ArtistSongs> LoadArtistSongs(std::int64_t artist_id, Depth want) const;

  std::optional<ArtistRef> LoadArtistRef(std::int64_t artist_id) const;

  // [SF-YM-08] Только среди уже резолвленных артистов — не ходит во внешний
  // гейтвей (Genius). Единственный поиск по имени, доступный без токена
  // (резолв совсем нового имени по-прежнему требует Genius, 422 без него).
  std::vector<ArtistRef> SearchArtistsByName(const std::string& query, int limit) const;

  std::vector<CollabEdge> LoadNeighbours(std::int64_t artist_id, const RoleMask& mask) const;

  Depth GetFetchDepth(std::int64_t artist_id) const;

  FetchState GetFetchState(std::int64_t artist_id) const;

  std::vector<std::int64_t> ListIncompleteArtists(Depth want, int limit, int offset) const;

  // [SF-API-20] Средний цвет фотографии артиста ("#rrggbb").
  // Ключ — image_url, а не id: считает цвет image-proxy, а он знает про
  // картинку ровно её адрес. Один и тот же адрес у двух артистов — законно
  // (общий плейсхолдер Genius), поэтому запись идёт по всем строкам с этим
  // адресом.
  // NeedsDominantColor нужен не ради экономии на UPDATE, а чтобы не
  // декодировать картинку заново: без него каждая отдача файла из прокси
  // стоила бы разбора JPEG.
  bool NeedsDominantColor(const std::string& image_url) const;

  void SetDominantColor(const std::string& image_url, const std::string& hex);

  // Цвета пачкой на весь граф: узлов полсотни, отдельный запрос на каждый
  // вернул бы ту же задачу «N обращений вместо одного», от которой уезжали.
  // Артисты без посчитанного цвета в ответе просто отсутствуют.
  std::unordered_map<std::int64_t, std::string> LoadDominantColors(
      const std::vector<std::int64_t>& artist_ids) const;

  bool Ping() const;

  void UpsertArtistSongs(const ArtistSongs& data, Depth new_depth);

  std::int64_t PruneStaleArtists(std::int64_t cutoff_ts, int batch_size);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;

  userver::engine::TaskProcessor& main_tp_;
  userver::engine::TaskWithResult<void> bootstrap_task_;
};

}  // namespace six_feat