// ════════════════════════════════════════════════════════════════════════════
// main.cpp  —  iteration 4
//
// Component registration order matters for userver DI:
//   GeniusClient must be registered before GraphHandler and PathHandler
//   because both depend on it via ComponentContext::FindComponent().
//   userver resolves the dependency graph automatically from kName strings
//   declared in GetStaticConfigSchema(), so the order here is just for
//   readability.
// ════════════════════════════════════════════════════════════════════════════

#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/utils/daemon_run.hpp>

#include "genius_client.hpp"
#include "graph_handler.hpp"
#include "path_handler.hpp"
#include "static_handler.hpp"

using namespace userver;

int main(int argc, char *argv[]) {
  const auto component_list =
      components::MinimalServerComponentList()
          .Append<clients::dns::Component>()
          .AppendComponentList(clients::http::ComponentList())
          // Shared service component — must precede handlers that depend on it.
          .Append<six_feat::GeniusClient>()
          // HTTP handlers
          .Append<six_feat::GraphHandler>()
          .Append<six_feat::PathHandler>()
          .Append<six_feat::IndexHandler>()
          .Append<six_feat::ScriptHandler>();

  return utils::DaemonMain(argc, argv, component_list);
}
