#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/utils/daemon_run.hpp>

#include "graph_handler.hpp"
#include "static_handler.hpp"

using namespace userver;

int main(int argc, char* argv[]) {
  const auto component_list =
      components::MinimalServerComponentList()
          // Infra needed to make outbound HTTP calls to Genius:
          .Append<clients::dns::Component>()
          .AppendComponentList(clients::http::ComponentList())
          // Our endpoints:
          .Append<six_feat::GraphHandler>()   // GET /api/v1/graph
          .Append<six_feat::IndexHandler>()   // GET /
          .Append<six_feat::ScriptHandler>();  // GET /script.js

  return utils::DaemonMain(argc, argv, component_list);
}
