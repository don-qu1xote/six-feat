#pragma once

#include <six-feat-auth-lib/api_key_store.hpp>
#include <six-feat-auth-lib/oauth_handler.hpp>
#include <six-feat-auth-lib/user_provider_token_store.hpp>
#include <six-feat-core/rate_limiter.hpp>
#include <string>
#include <string_view>
#include <userver/components/component_fwd.hpp>
#include <userver/yaml_config/schema.hpp>

#include "application/collab_service.hpp"
#include "authenticated_handler_base.hpp"
#include "token_router.hpp"

namespace six_feat {

// [SF-API-23] Совместные треки одной пары — по требованию.
// Ответ графа их больше не несёт: пользователь за сессию раскрывает одно-два
// ребра, а разбирал JSON и держал в памяти треки всех рёбер сразу.
// Авторизация, ключи, лимит и разбор ролей — те же, что у /api/v1/graph:
// ручка отвечает на тот же вопрос про тот же граф, просто про одно ребро, и
// заводить ей отдельную политику доступа было бы неправдой про модель данных.
class GraphEdgeHandler final : public AuthenticatedHandlerBase {
 public:
  static constexpr std::string_view kName = "handler-graph-edge";

  GraphEdgeHandler(const userver::components::ComponentConfig& config,
                   const userver::components::ComponentContext& context);

  std::string HandleRequestThrow(const userver::server::http::HttpRequest& request,
                                 userver::server::request::RequestContext& context) const override;

  static userver::yaml_config::Schema GetStaticConfigSchema();

 private:
  CollabService& service_;
  const auth::OAuthConfig& oauth_;
  auth::ApiKeyStore& api_key_store_;
  auth::UserProviderTokenStore& user_provider_tokens_;
  mutable PerIpRateLimit rate_limit_;
};

}  // namespace six_feat
