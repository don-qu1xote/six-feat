#include <userver/clients/dns/component.hpp>
#include <userver/clients/http/component.hpp>
#include <userver/clients/http/component_list.hpp>
#include <userver/components/minimal_server_component_list.hpp>
#include <userver/utils/daemon_run.hpp>

#include "graph_handler.hpp"
#include "static_handler.hpp"

using namespace userver;

int main(int argc, char *argv[]) {
  const auto component_list =
      components::MinimalServerComponentList()
          .Append<clients::dns::Component>()
          .AppendComponentList(clients::http::ComponentList())
          .Append<six_feat::GraphHandler>()
          .Append<six_feat::IndexHandler>()
          .Append<six_feat::ScriptHandler>();

  return utils::DaemonMain(argc, argv, component_list);
}
