import { spawnSync } from "node:child_process";

const severityOrder = ["low", "moderate", "high", "critical"];
const threshold = (process.env.SECURITY_AUDIT_LEVEL || "critical").toLowerCase();

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function parseAuditOutput(stdout) {
  if (!stdout?.trim()) {
    return null;
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function vulnerabilityCounts(audit) {
  const vulnerabilities = audit?.metadata?.vulnerabilities ?? {};

  return {
    low: Number(vulnerabilities.low ?? 0),
    moderate: Number(vulnerabilities.moderate ?? 0),
    high: Number(vulnerabilities.high ?? 0),
    critical: Number(vulnerabilities.critical ?? 0),
  };
}

function countAtOrAbove(counts, configuredThreshold) {
  const thresholdIndex = severityOrder.indexOf(configuredThreshold);

  if (thresholdIndex < 0) {
    fail("Invalid SECURITY_AUDIT_LEVEL.", {
      threshold: configuredThreshold,
      allowed: severityOrder,
    });
  }

  return severityOrder
    .slice(thresholdIndex)
    .reduce((total, severity) => total + counts[severity], 0);
}

const result = spawnSync(
  "npm",
  ["audit", "--json", "--audit-level", threshold],
  {
    encoding: "utf8",
  }
);
const audit = parseAuditOutput(result.stdout);

if (!audit) {
  fail("Dependency audit did not return parseable JSON.", {
    exitCode: result.status,
    stderr: result.stderr,
  });
}

const counts = vulnerabilityCounts(audit);
const total =
  counts.low + counts.moderate + counts.high + counts.critical;
const thresholdCount = countAtOrAbove(counts, threshold);
const status = thresholdCount > 0 ? "FAIL" : total > 0 ? "WARNING" : "PASS";
const summary = {
  status,
  threshold,
  totalVulnerabilities: total,
  counts,
  thresholdViolations: thresholdCount,
  checkedAt: new Date().toISOString(),
};

console.log(JSON.stringify(summary, null, 2));

if (thresholdCount > 0) {
  process.exit(1);
}
