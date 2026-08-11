













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
