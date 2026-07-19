#include "core/request_id.hpp"

#include <userver/engine/task/inherited_variable.hpp>
#include <userver/server/http/http_response.hpp>
#include <userver/tracing/span.hpp>
#include <userver/utils/uuid4.hpp>

namespace six_feat {

namespace {

// [SF-OBS-02] Deliberately NOT tracing::Span's trace_id/link: userver's own
// HTTP server component already extracts/generates both from its own
// tracing headers before handler code runs (and Span::SetLink() may only
// be called once per span), so overwriting either here would fight the
// framework rather than cooperate with it. A TaskInheritedVariable is
// inherited by every task forked via utils::Async from the one that set
// it, which is exactly the propagation CurrentRequestId() needs.
userver::engine::TaskInheritedVariable<std::string> kRequestIdVariable;

} // namespace

std::string EnsureRequestId(const userver::server::http::HttpRequest& request) {
    auto& span = userver::tracing::Span::CurrentSpan();

    // [SF-OBS-02] An incoming X-Request-Id (set by GeniusGatewayClient /
    // EnrichmentClient / internal_http on the calling service) takes
    // priority over this service's own span trace id, so the same id
    // survives every hop of the chain instead of resetting at each one.
    std::string id = request.GetHeader(std::string{kRequestIdHeader});
    if (id.empty()) {
        id = std::string{span.GetTraceId()};
    }
    if (id.empty()) {
        id = userver::utils::generators::GenerateUuid();
    }

    span.AddTag("request_id", id);
    kRequestIdVariable.Set(id);
    request.GetHttpResponse().SetHeader(std::string{kRequestIdHeader}, id);
    return id;
}

std::string CurrentRequestId() {
    if (const auto* id = kRequestIdVariable.GetOptional()) {
        return *id;
    }
    // Fallback for any (currently theoretical) caller reached without an
    // EnsureRequestId() ancestor — matches the pre-SF-OBS-02 behaviour.
    return std::string{userver::tracing::Span::CurrentSpan().GetTraceId()};
}

} // namespace six_feat
