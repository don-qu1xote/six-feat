#include <six-feat-core/request_id.hpp>
#include <userver/engine/task/inherited_variable.hpp>
#include <userver/server/http/http_response.hpp>
#include <userver/tracing/span.hpp>
#include <userver/utils/uuid4.hpp>

namespace six_feat {

namespace {

userver::engine::TaskInheritedVariable<std::string> request_id_variable;

}
std::string EnsureRequestId(const userver::server::http::HttpRequest& request) {
  auto& span = userver::tracing::Span::CurrentSpan();

  std::string id = request.GetHeader(std::string{kRequestIdHeader});
  if (id.empty()) {
    id = std::string{span.GetTraceId()};
  }
  if (id.empty()) {
    id = userver::utils::generators::GenerateUuid();
  }

  span.AddTag("request_id", id);
  request_id_variable.Set(id);
  request.GetHttpResponse().SetHeader(std::string{kRequestIdHeader}, id);
  return id;
}

std::string CurrentRequestId() {
  if (const auto* id = request_id_variable.GetOptional()) {
    return *id;
  }
  return std::string{userver::tracing::Span::CurrentSpan().GetTraceId()};
}

}  // namespace six_feat