#include <six-feat-http/readiness_common.hpp>

#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>

namespace six_feat {

using namespace userver;

std::string BuildReadinessBody(const server::http::HttpRequest& request,
                               const std::vector<ReadinessCheck>& checks) {
  request.GetHttpResponse().SetContentType(http::ContentType("application/json"));

  bool ready = true;
  formats::json::ValueBuilder checks_out(formats::json::Type::kObject);
  for (const auto& check : checks) {
    formats::json::ValueBuilder check_out(formats::json::Type::kObject);
    check_out["ok"] = check.ok;
    check_out["status"] = check.status;
    checks_out[check.name] = std::move(check_out);
    ready = ready && check.ok;
  }

  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["status"] = ready ? std::string{"ready"} : std::string{"not_ready"};
  b["checks"] = std::move(checks_out);

  if (!ready) {
    request.GetHttpResponse().SetStatus(server::http::HttpStatus::kServiceUnavailable);
  }

  return formats::json::ToString(b.ExtractValue());
}

}  // namespace six_feat