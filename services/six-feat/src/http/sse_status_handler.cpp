
#include "http/sse_status_handler.hpp"

#include "schemas/handlers/six-feat/sse_status_handler_schema.hpp"

#include <chrono>
#include <string>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/engine/deadline.hpp>
#include <userver/engine/exception.hpp>
#include <userver/engine/sleep.hpp>
#include <userver/engine/task/cancel.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/http/content_type.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/server/http/http_response.hpp>
#include <userver/server/http/http_response_body_stream.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat {

using namespace userver;

namespace {

constexpr int kFullDepth = static_cast<int>(Depth::Full);
constexpr std::chrono::seconds kPollInterval{2};

std::string MakeSseEvent(std::int64_t depth, int song_count, bool enriching) {
  formats::json::ValueBuilder b(formats::json::Type::kObject);
  b["depth"] = depth;
  b["song_count"] = song_count;
  b["enriching"] = enriching;
  return "data: " + formats::json::ToString(b.ExtractValue()) + "\n\n";
}

}  // namespace
SseStatusHandler::SseStatusHandler(const components::ComponentConfig& config,
                                   const components::ComponentContext& context)
    : AuthenticatedHandlerBase(config, context, context.FindComponent<auth::OAuthConfig>()),
      store_(context.FindComponent<PersistentStore>()),
      enrichment_(context.FindComponent<EnrichmentClient>()) {}

void SseStatusHandler::HandleStreamRequest(
    server::http::HttpRequest& request,
    server::request::RequestContext&,
    server::http::ResponseBodyStream& response_body_stream) const {
  auto& response = request.GetHttpResponse();

  if (!PrologueStream(request)) {
    response_body_stream.SetEndOfHeaders();
    response_body_stream.PushBodyChunk(std::string{R"({"error":"not_authenticated"})"},
                                       engine::Deadline());
    return;
  }

  const auto& id_str = request.GetArg("id");
  if (id_str.empty()) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    response_body_stream.SetEndOfHeaders();
    response_body_stream.PushBodyChunk(std::string{R"({"error":"missing ?id=<artist_id>"})"},
                                       engine::Deadline());
    return;
  }

  std::int64_t artist_id = 0;
  try {
    std::size_t pos = 0;
    artist_id = std::stoll(id_str, &pos);
    if (pos != id_str.size()) {
      response.SetStatus(server::http::HttpStatus::kBadRequest);
      response_body_stream.SetEndOfHeaders();
      response_body_stream.PushBodyChunk(std::string{R"({"error":"id must be an integer"})"},
                                         engine::Deadline());
      return;
    }
  } catch (...) {
    response.SetStatus(server::http::HttpStatus::kBadRequest);
    response_body_stream.SetEndOfHeaders();
    response_body_stream.PushBodyChunk(std::string{R"({"error":"id must be an integer"})"},
                                       engine::Deadline());
    return;
  }

  response.SetContentType(http::ContentType("text/event-stream"));
  response.SetHeader(std::string{"Cache-Control"}, std::string{"no-cache"});
  response.SetHeader(std::string{"X-Accel-Buffering"}, std::string{"no"});
  response_body_stream.SetEndOfHeaders();

  for (;;) {
    const auto state = store_.GetFetchState(artist_id);
    const int depth = static_cast<int>(state.depth);
    const bool enriching = enrichment_.IsEnriching(artist_id);

    try {
      response_body_stream.PushBodyChunk(MakeSseEvent(depth, state.song_count, enriching),
                                         engine::Deadline());
    } catch (const engine::WaitInterruptedException&) {
      return;
    }

    if (depth >= kFullDepth) {
      return;
    }

    engine::InterruptibleSleepFor(kPollInterval);
    if (engine::current_task::ShouldCancel()) {
      return;
    }
  }
}

userver::yaml_config::Schema SseStatusHandler::GetStaticConfigSchema() {
  return yaml_config::MergeSchemas<HttpHandlerBase>(kSseStatusHandlerSchema);
}

}  // namespace six_feat