#include "genius/genius_error_mapping.hpp"

namespace six_feat {

std::string MapGeniusHttpError(const GeniusHttpError&                error,
                                userver::server::http::HttpResponse& response)
{
    using userver::server::http::HttpStatus;

    if (error.status_code == 401) {
        response.SetStatus(HttpStatus::kUnauthorized);
        return "token_invalid";
    }
    // Client disconnected mid-request (AbortController / new navigation).
    // The response is going nowhere either way — return promptly with a
    // standard, already-used-elsewhere status code rather than mislabeling
    // this as a Genius outage (502), which it isn't.
    if (error.status_code == 499) {
        response.SetStatus(HttpStatus::kServiceUnavailable);
        return "client_cancelled";
    }
    response.SetStatus(error.status_code == 503
        ? HttpStatus::kServiceUnavailable
        : HttpStatus::kBadGateway);
    return "genius_error";
}

} // namespace six_feat
