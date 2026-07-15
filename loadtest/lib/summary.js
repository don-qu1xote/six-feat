// loadtest/lib/summary.js — SF-INF-05
//
// Hand-rolled handleSummary() formatter, used by every loadtest/scenarios/
// *.js script instead of pulling in the jslib.k6.io/k6-summary remote
// import — keeps the whole harness self-contained (no network fetch of a
// third-party script at run time), matching this repo's general pinned-
// dependency posture (SF-CI-03 SBOM/cosign, pinned Actions digests
// elsewhere in .github/workflows/).
//
// Writes both the full JSON summary (data, verbatim) and a short text
// digest to <outPrefix>-summary.{json,txt}, and echoes the text digest to
// stdout (k6 suppresses its own default stdout summary once handleSummary
// is defined, unless the returned object includes a "stdout" key itself).

function formatMs(v) {
  return `${(v ?? 0).toFixed(1)}ms`;
}

function buildTextSummary(data, title) {
  const m = data.metrics || {};
  const dur = (m.http_req_duration && m.http_req_duration.values) || {};
  const failedRate = (m.http_req_failed && m.http_req_failed.values.rate) || 0;
  const checksRate = (m.checks && m.checks.values.rate) ?? 1;
  const iterations = (m.iterations && m.iterations.values.count) || 0;

  const lines = [];
  lines.push(`=== ${title} ===`);
  lines.push(`iterations:        ${iterations}`);
  lines.push(
    `http_req_duration: avg=${formatMs(dur.avg)} p(95)=${formatMs(dur["p(95)"])} max=${formatMs(dur.max)}`
  );
  lines.push(`http_req_failed:   ${(failedRate * 100).toFixed(2)}%`);
  lines.push(`checks passed:     ${(checksRate * 100).toFixed(2)}%`);
  lines.push("");
  lines.push("thresholds (advisory — see loadtest/README.md):");
  let any = false;
  for (const [metricName, metric] of Object.entries(m)) {
    if (!metric.thresholds) continue;
    for (const [expr, result] of Object.entries(metric.thresholds)) {
      any = true;
      lines.push(`  ${metricName} ${expr}: ${result.ok ? "OK" : "WARN (breached)"}`);
    }
  }
  if (!any) lines.push("  (none)");
  return lines.join("\n") + "\n";
}

export function summaryHandler(title, outPrefix) {
  return function handleSummary(data) {
    const text = buildTextSummary(data, title);
    return {
      stdout: text,
      [`${outPrefix}-summary.json`]: JSON.stringify(data, null, 2),
      [`${outPrefix}-summary.txt`]: text,
    };
  };
}
