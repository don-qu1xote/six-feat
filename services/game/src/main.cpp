#include "core/challenge_rules.hpp"
#include "core/game_store.hpp"

#include <six-feat-core/rate_limit_store_component.hpp>
#include <six-feat-http/health_handler.hpp>
#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/server/handlers/server_monitor.hpp>
#include <userver/storages/postgres/component.hpp>
#include <userver/testsuite/testsuite_support.hpp>
#include <userver/utils/daemon_run.hpp>

#include "api/v1/game/admin_handler.hpp"
#include "api/v1/game/challenge_handler.hpp"
#include "api/v1/game/challenges_handler.hpp"
#include "api/v1/game/leaderboard_handler.hpp"
#include "api/v1/game/link_handler.hpp"
#include "api/v1/game/profile_handler.hpp"
#include "api/v1/game/season_handler.hpp"
#include "api/v1/game/submit_handler.hpp"
#include "api/v1/game/validate_handler.hpp"
#include "infrastructure/neighbours_client.hpp"
#include "scheduler/daily_challenge_task.hpp"
#include "system/readiness_handler.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
  const auto component_list = components::MinimalServerComponentList()
                                  .Append<clients::dns::Component>()
                                  .AppendComponentList(clients::http::ComponentList())
                                  .Append<components::TestsuiteSupport>()
                                  .Append<six_feat::game::NeighboursClient>()
                                  .Append<components::Postgres>("postgres-db-1")
                                  .Append<six_feat::game::GameStore>()
                                  .Append<six_feat::game::ChallengeRules>()
                                  .Append<six_feat::RateLimitStoreComponent>()
                                  .Append<six_feat::HealthHandler>()
                                  .Append<six_feat::game::ReadinessHandler>()
                                  .Append<six_feat::game::ProfileHandler>()
                                  .Append<six_feat::game::ValidateHandler>()
                                  .Append<six_feat::game::SubmitHandler>()
                                  .Append<six_feat::game::ChallengeHandler>()
                                  .Append<six_feat::game::DailyChallengeTask>()
                                  .Append<six_feat::game::LeaderboardHandler>()
                                  .Append<six_feat::game::LinkHandler>()
                                  .Append<six_feat::game::ChallengesHandler>()
                                  .Append<six_feat::game::SeasonHandler>()
                                  .Append<six_feat::game::AdminHandler>()
                                  .Append<server::handlers::ServerMonitor>();

  return utils::DaemonMain(argc, argv, component_list);
}
