#include <six-feat-http/health_handler.hpp>
#include <six-feat-yandex/yandex_device_auth_client.hpp>
#include <six-feat-yandex/yandex_music_gateway.hpp>
#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "internal/yandex/account_handler.hpp"
#include "internal/yandex/artist_tracks_handler.hpp"
#include "internal/yandex/device_poll_handler.hpp"
#include "internal/yandex/device_start_handler.hpp"
#include "internal/yandex/liked_tracks_handler.hpp"
#include "internal/yandex/playlist_tracks_handler.hpp"
#include "internal/yandex/playlists_handler.hpp"
#include "internal/yandex/search_artist_handler.hpp"
#include "internal/yandex/track_artists_handler.hpp"
#include "system/readiness_handler.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
  const auto component_list = components::MinimalServerComponentList()
                                  .Append<clients::dns::Component>()
                                  .AppendComponentList(clients::http::ComponentList())
                                  .Append<components::TestsuiteSupport>()
                                  .Append<six_feat::YandexMusicGateway>()
                                  .Append<six_feat::YandexDeviceAuthClient>()
                                  .Append<six_feat::yandex_gateway::TrackArtistsHandler>()
                                  .Append<six_feat::yandex_gateway::SearchArtistHandler>()
                                  .Append<six_feat::yandex_gateway::ArtistTracksHandler>()
                                  .Append<six_feat::yandex_gateway::DeviceStartHandler>()
                                  .Append<six_feat::yandex_gateway::DevicePollHandler>()
                                  .Append<six_feat::yandex_gateway::PlaylistsHandler>()
                                  .Append<six_feat::yandex_gateway::LikedTracksHandler>()
                                  .Append<six_feat::yandex_gateway::PlaylistTracksHandler>()
                                  .Append<six_feat::yandex_gateway::AccountHandler>()
                                  .Append<six_feat::HealthHandler>()
                                  .Append<six_feat::yandex_gateway::ReadinessHandler>()
                                  .Append<server::handlers::ServerMonitor>();

  return utils::DaemonMain(argc, argv, component_list);
}
