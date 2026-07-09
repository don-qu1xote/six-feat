#include "core/request_id.hpp"

#include <userver/server/http/http_response.hpp>
#include <userver/tracing/span.hpp>
#include <userver/utils/uuid4.hpp>

namespace six_feat {

std::string EnsureRequestId(const userver::server::http::HttpRequest& request) {
    auto& span = userver::tracing::Span::CurrentSpan();

    std::string id{span.GetTraceId()};
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
