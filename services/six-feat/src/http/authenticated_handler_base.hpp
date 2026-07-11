#pragma once

// ════════════════════════════════════════════════════════════════════════════
// authenticated_handler_base.hpp
//
// AuthenticatedHandlerBase — shared prologue for handlers that require a
// valid Genius session (SF-API-01). Collapses the copy-pasted
//   EnsureRequestId(request);
//   ApplySecurityHeaders(request);
//   const auto session = auth::RequireSession(request, oauth_);
//   if (!session) { ...own error body... }
// sequence duplicated across graph/path/search/status/sse_status handlers
// into one place. Error bodies stay per-handler (they differ byte-for-byte),
// so Prologue()/PrologueStream() only return the token — the caller returns
// its own body when they come back std::nullopt (status is already 401 by
// then, set inside auth::RequireSession).
// ════════════════════════════════════════════════════════════════════════════

#include "auth/oauth_handler.hpp"
#include "auth/token_router.hpp"
#include "core/request_id.hpp"
#include "core/security_headers.hpp"

#include <optional>
#include <string>

#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/server/http/http_request.hpp>

namespace six_feat {

class AuthenticatedHandlerBase
    : public userver::server::handlers::HttpHandlerBase {
public:
    AuthenticatedHandlerBase(
        const userver::components::ComponentConfig&  config,
        const userver::components::ComponentContext& context,
        auth::OAuthConfig&                           oauth)
        : HttpHandlerBase(config, context), oauth_(oauth)
    {}

protected:
    // EnsureRequestId → ApplySecurityHeaders → RequireSession, for handlers
    // returning the body via HandleRequestThrow's std::string return value.
    std::optional<std::string> Prologue(
        const userver::server::http::HttpRequest& request) const
    {
        EnsureRequestId(request);
        ApplySecurityHeaders(request);
        return auth::RequireSession(request, oauth_);
    }

    // Same prologue for HandleStreamRequest, which takes a non-const
    // HttpRequest&.
    std::optional<std::string> PrologueStream(
        userver::server::http::HttpRequest& request) const
    {
        EnsureRequestId(request);
        ApplySecurityHeaders(request);
        return auth::RequireSession(request, oauth_);
    }

private:
    auth::OAuthConfig& oauth_;
};

} // namespace six_feat
