#pragma once

// ════════════════════════════════════════════════════════════════════════════
// genius_error_mapping.hpp
//
// IDEA-2: The GeniusHttpError → HTTP mapping was duplicated ~4 times across
// graph_handler.cpp (id branch + name branch), path_handler.cpp (resolve +
// find-path branches) and search_handler.cpp:
//
//   401 -> 401 "token_invalid"
//   499 -> 503 "client_cancelled"   (client disconnected mid-request)
//   503 -> 503 "genius_error"
//   *   -> 502 "genius_error"       ("could not reach Genius")
//
// MapGeniusHttpError() sets the correct status on `response` and returns the
// canonical error code above. Handlers keep ownership of their own response
// body format (graph/path/search each build different JSON shapes) — they
// just switch on the returned code to fill in their existing messages.
// ════════════════════════════════════════════════════════════════════════════

#include "core/resilience.hpp"

#include <string>

#include <userver/server/http/http_response.hpp>

namespace six_feat {

// Sets the correct HTTP status on `response` for `error` and returns the
// canonical error code for the response body: "token_invalid",
// "client_cancelled" or "genius_error".
std::string MapGeniusHttpError(const GeniusHttpError&                error,
                                userver::server::http::HttpResponse& response);

} // namespace six_feat
