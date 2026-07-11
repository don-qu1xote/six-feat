#include "core/request_id.hpp"

#include <userver/server/http/http_response.hpp>
#include <userver/tracing/span.hpp>
#include <userver/utils/uuid4.hpp>

namespace six_feat {

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
    request.GetHttpResponse().SetHeader(std::string{kRequestIdHeader}, id);
    return id;
}

std::string CurrentRequestId() {
    return std::string{userver::tracing::Span::CurrentSpan().GetTraceId()};
}

} // namespace six_feat
