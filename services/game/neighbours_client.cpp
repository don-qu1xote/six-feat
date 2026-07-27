#include "neighbours_client.hpp"
#include "core/internal_auth.hpp"
#include "core/internal_http.hpp"
#include "core/request_id.hpp"
#include "schemas/components/neighbours_client_schema.hpp"

#include <algorithm>
#include <stdexcept>
#include <string>

#include <userver/clients/http/component.hpp>
#include <userver/components/component_config.hpp>
#include <userver/components/component_context.hpp>
#include <userver/formats/json/serialize.hpp>
#include <userver/formats/json/value_builder.hpp>
#include <userver/logging/log.hpp>
#include <userver/yaml_config/merge_schemas.hpp>

namespace six_feat::game {

using namespace userver;

namespace {

int RequirePositive(std::string_view param, int value) {
    if (value <= 0) {
        throw std::runtime_error(
            "neighbours-client: " + std::string(param) +
            " must be a positive integer, got " + std::to_string(value));
    }
    return value;
}

} // namespace

NeighboursClient::NeighboursClient(
    const components::ComponentConfig&  config,
    const components::ComponentContext& context)
    : ComponentBase(config, context)
    , http_client_(
          context.FindComponent<components::HttpClient>().GetHttpClient())
    , base_url_(config["six-feat-base-url"].As<std::string>())
    , shared_secret_(six_feat::internal_api::SharedSecretFromEnv())
    , timeout_(std::chrono::milliseconds{RequirePositive(
          "timeout-ms", config["timeout-ms"].As<int>(2000))})
{}

// artist_id/role_mask are distinct fields named at every call site (a
// Genius artist id vs. a role bitmask); swapping them is not a realistic
// mistake.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
std::optional<std::vector<std::int64_t>>
NeighboursClient::Neighbours(std::int64_t artist_id, int role_mask) const {
    try {
        formats::json::ValueBuilder b(formats::json::Type::kObject);
        b["artist_id"] = artist_id;
        if (role_mask > 0) b["role_mask"] = role_mask;

        const auto resp = six_feat::internal_http::Post(
            http_client_, base_url_ + "/internal/neighbours", shared_secret_,
            formats::json::ToString(b.ExtractValue()), timeout_,
            six_feat::CurrentRequestId());

        if (resp.status_code < 200 || resp.status_code >= 300) {
            LOG_WARNING() << "[NeighboursClient] neighbours(" << artist_id
                          << ") failed: HTTP " << resp.status_code;
            return std::nullopt;
        }

        const auto body = formats::json::FromString(resp.body);
        std::vector<std::int64_t> out;
        for (const auto& v : body["neighbours"]) {
            out.push_back(v.As<std::int64_t>());
        }
        return out;
    } catch (const std::exception& ex) {
        LOG_WARNING() << "[NeighboursClient] neighbours(" << artist_id
                      << ") failed: " << ex.what();
        return std::nullopt;
    }
}

// from/to are distinct hop endpoints (chain step source/destination) named
// at every call site; swapping them is not a realistic mistake.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
bool NeighboursClient::IsRealHop(std::int64_t from, std::int64_t to,
                                 int role_mask) const {
    const auto neighbours = Neighbours(from, role_mask);
    if (!neighbours) return false;
    return std::find(neighbours->begin(), neighbours->end(), to) !=
           neighbours->end();
}

yaml_config::Schema NeighboursClient::GetStaticConfigSchema() {
    return yaml_config::MergeSchemas<components::ComponentBase>(
        kNeighboursClientComponentSchema);
}

} // namespace six_feat::game
