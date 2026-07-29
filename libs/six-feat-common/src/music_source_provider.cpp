#include <six-feat-common/music_source_provider.hpp>

namespace six_feat {

const char* ToString(EdgeSource source) {
  switch (source) {
    case EdgeSource::YandexFeature:
      return "yandex_feature";
    case EdgeSource::GeniusCredit:
      return "genius_credit";
  }
  return "unknown";
}

const char* ToString(DiscoverySource source) {
  switch (source) {
    case DiscoverySource::YandexTrack:
      return "yandex_track";
    case DiscoverySource::GeniusCredit:
      return "genius_credit";
    case DiscoverySource::YandexPlaylist:
      return "yandex_playlist";
  }
  return "unknown";
}

}  // namespace six_feat
