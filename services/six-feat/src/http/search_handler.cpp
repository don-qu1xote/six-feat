
#include "http/search_handler.hpp"

#include <six-feat-core/http_cache.hpp>
#include <six-feat-core/rate_limit_store_component.hpp>
#include <six-feat-core/request_id.hpp>
#include <six-feat-core/security_headers.hpp>

#include "genius/genius_error_mapping.hpp"

#include "schemas/handlers/six-feat/search_handler_schema.hpp"

#include <algorithm>
#include <cctype>
#include <functional>
#include <string>
#include <string_view>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
std::string ErrorJson(const std::string& code, const std::string& msg) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["type"] = std::string{"search"};
  b["error"] = code;
  b["message"] = msg;
  b["request_id"] = CurrentRequestId();
  return formats::json::ToString(b.ExtractValue());
}

std::string GeniusErrorJson(const GeniusHttpError& e, server::http::HttpResponse& response) {
  const std::string code = MapGeniusHttpError(e, response);
  if (code == "token_invalid") {
    return ErrorJson("token_invalid",
                     "Your Genius token is no longer valid — please sign in again.");
  }
  if (code == "client_cancelled") {
    return ErrorJson("client_cancelled", "client request cancelled");
  }
  return ErrorJson("genius_error", "could not reach Genius");
}

std::string RateLimitKey(const server::http::HttpRequest& request, const auth::OAuthConfig& oauth) {
  std::string token = auth::ExtractToken(request, oauth.SessionKey());
  if (!token.empty()) return token;
  return request.GetRemoteAddress().PrimaryAddressString();
}

std::string NormalizeQuery(const std::string& query) {
  std::size_t begin = 0, end = query.size();
  while (begin < end && std::isspace(static_cast<unsigned char>(query[begin]))) ++begin;
  while (end > begin && std::isspace(static_cast<unsigned char>(query[end - 1]))) --end;
  std::string out = query.substr(begin, end - begin);
  std::transform(
      out.begin(), out.end(), out.begin(), [](unsigned char c) { return std::tolower(c); });
  return out;
}

std::string BuildSearchETag(const std::string& normalized_query,
                            const std::vector<Candidate>& candidates) {
  std::string ids;
  ids.reserve(candidates.size() * 8);
  for (const auto& c : candidates) {
    ids += std::to_string(c.id);
    ids += ',';
  }
  return "W/\"" + std::to_string(std::hash<std::string>{}(normalized_query)) + "-" +
         std::to_string(candidates.size()) + "-" + std::to_string(std::hash<std::string>{}(ids)) +
         "\"";
}

}  // namespace
SearchHandler::SearchHandler(const components::ComponentConfig& config,
                             const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context, context.FindComponent<auth::OAuthConfig>()),
      gateway_(context.FindComponent<GeniusGatewayClient>()),
      oauth_(context.FindComponent<auth::OAuthConfig>()),
      rate_limit_("search", 50, 1, context.FindComponent<RateLimitStoreComponent>().MakeStore()) {}

std::string SearchHandler::HandleRequestThrow(const server::http::HttpRequest& request,
                                              server::request::RequestContext&) const {
  EnsureRequestId(request);
  ApplySecurityHeaders(request);

  auto& response = request.GetHttpResponse();
  response.SetContentType(http::ContentType{"application/json; charset=utf-8"});

  const std::string limit_key = RateLimitKey(request, oauth_);
  if (!rate_limit_.Allow(limit_key)) {
    response.SetStatus(server::http::HttpStatus::kTooManyRequests);
    response.SetHeader(std::string{"Retry-After"}, std::string{"1"});
    response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rate_limit_.Limit()));
    response.SetHeader(std::string{"X-RateLimit-Remaining"}, std::string{"0"});
    return ErrorJson("rate_limit_exceeded", "rate limit exceeded");
  }
  response.SetHeader(std::string{"X-RateLimit-Limit"}, std::to_string(rate_limit_.Limit()));
  response.SetHeader(std::string{"X-RateLimit-Remaining"},
                     std::to_string(rate_limit_.Remaining(limit_key)));

  const auto token = Prologue(request);
  if (!token) {
    return ErrorJson("not_authenticated", "Login with Genius to search for artists.");
  }
  const std::string& user_token = *token;

  const std::string& query = request.GetArg("q");
  if (query.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    return ErrorJson("bad_request", "'q' query parameter is required");
  }

  std::vector<Candidate> candidates;
  try {
    candidates = gateway_.ResolveCandidates(query, user_token);
  } catch (const GeniusHttpError& e) {
    return GeniusErrorJson(e, response);
  } catch (...) {
    response.SetStatus(server::http::HttpStatus::kBadGateway);
    return ErrorJson("genius_error", "could not reach Genius");
  }

  const std::string normalized_query = NormalizeQuery(query);
  const std::string etag = BuildSearchETag(normalized_query, candidates);
  response.SetHeader(std::string{"ETag"}, etag);
  response.SetHeader(std::string{"Cache-Control"}, std::string{"private, must-revalidate"});

  const std::string& if_none_match = request.GetHeader(std::string_view{"If-None-Match"});
  if (ETagMatches(if_none_match, etag)) {
    response.SetStatus(server::http::HttpStatus::kNotModified);
    return {};
  }

  formats::json::ValueBuilder out(formats::json::Type::kObject);
  out["type"] = std::string{"search"};
  out["query"] = query;
  formats::json::ValueBuilder arr(formats::json::Type::kArray);
  for (const auto& c : candidates) {
    formats::json::ValueBuilder cb(formats::json::Type::kObject);
    cb["id"] = c.id;
    cb["name"] = c.name;
    if (!c.image.empty()) cb["image"] = c.image;
    if (!c.url.empty()) cb["url"] = c.url;
    cb["score"] = c.score;
    arr.PushBack(std::move(cb));
  }
  out["candidates"] = std::move(arr);
  return formats::json::ToString(out.ExtractValue());
}

yaml_config::Schema SearchHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<server::handlers::HttpHandlerBase>(kSearchHandlerSchema);
}

}  // namespace six_feat