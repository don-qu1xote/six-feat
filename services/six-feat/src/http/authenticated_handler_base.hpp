#pragma once

#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>

#include <six-feat-auth-lib/oauth_handler.hpp>
#include "auth/token_router.hpp"

#include <optional>
#include <string>
#include <userver/components/component_fwd.hpp>
#include <userver/server/handlers/http_handler_base.hpp>
#include <userver/server/http/http_request.hpp>

namespace six_feat {

class AuthenticatedHandlerBase : public userver::server::handlers::HttpHandlerBase {
 public:
  AuthenticatedHandlerBase(const userver::components::ComponentConfig& config,
                           const userver::components::ComponentContext& context,
                           auth::OAuthConfig& oauth)
      : HttpHandlerBase(config, context), oauth_(oauth) {}

 protected:
  std::optional<std::string> Prologue(const userver::server::http::HttpRequest& request) const {
    EnsureRequestId(request);
    ApplySecurityHeaders(request);
    return auth::RequireSession(request, oauth_);
  }

  std::optional<std::string> PrologueStream(userver::server::http::HttpRequest& request) const {
    EnsureRequestId(request);
    ApplySecurityHeaders(request);
    return auth::RequireSession(request, oauth_);
  }

 private:
  auth::OAuthConfig& oauth_;
};

}  // namespace six_feat