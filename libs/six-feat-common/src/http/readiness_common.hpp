#pragma once

// ════════════════════════════════════════════════════════════════════════════
// readiness_common.hpp  —  SF-INF-03
//
// Shared wire format for every service's GET /readyz. Each service still
// has its own ReadinessHandler HttpHandlerBase subclass (the SET of checks
// genuinely differs per service — a Postgres ping only makes sense where
// there's a Postgres, a circuit-breaker check only where there's an
// upstream circuit breaker), but they all build their response through
// BuildReadinessBody below, so the body SHAPE is identical everywhere:
//
//   200 {"status":"ready",    "checks":{"<name>":{"ok":true, "status":"..."}, ...}}
//   503 {"status":"not_ready","checks":{"<name>":{"ok":false,"status":"..."}, ...}}
//
// A check is "gating" (its ok=false flips the overall status/HTTP code to
// not_ready/503) simply by being included with ok=false — there's no
// separate mandatory/soft flag. A service that wants a check to be purely
// informational (visible in checks{} but never able to fail readiness on
// its own — see genius-gateway's own README-equivalent comment on why an
// upstream Genius outage alone doesn't necessarily mean THAT service can't
// serve anything) just always reports ok=true for it while still varying
// `status`.
// ════════════════════════════════════════════════════════════════════════════

#include <string>
#include <vector>

#include <userver/server/http/http_request.hpp>

namespace six_feat {

struct ReadinessCheck {
    std::string name;
    bool        ok;
    // Free-form, check-specific (e.g. "ok"/"mismatch"/"unknown"/"unreachable"
    // for app_secret_parity, "closed"/"open"/"half_open" for a circuit
    // breaker). Every check reports one — checks with only a boolean
    // outcome just reuse "ok"/"error".
    std::string status;
};

// Builds the unified {"status":...,"checks":{...}} body, sets the response
// status to 503 if any check has ok=false (200 otherwise), and sets the
// application/json content type. Does NOT call EnsureRequestId/
// ApplySecurityHeaders — callers do that first, same as every other
// handler in this codebase.
std::string BuildReadinessBody(const userver::server::http::HttpRequest& request,
                                const std::vector<ReadinessCheck>&        checks);

} // namespace six_feat
