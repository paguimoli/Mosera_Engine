const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function getArgValue(args, name) {
  const index = args.indexOf(name);

  if (index < 0) {
    return null;
  }

  return args[index + 1] || null;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function parseArgs(args) {
  return {
    runType: (getArgValue(args, "--runType") || "FULL").toUpperCase(),
    scopeType: (getArgValue(args, "--scopeType") || getArgValue(args, "--scope") || "GLOBAL").toUpperCase(),
    scopeId: getArgValue(args, "--scopeId"),
    weekStart: getArgValue(args, "--weekStart"),
    weekEnd: getArgValue(args, "--weekEnd"),
    currency: getArgValue(args, "--currency")?.toUpperCase() || null,
    allowFail: hasFlag(args, "--allowFail") || hasFlag(args, "--allow-fail"),
  };
}

function fail(message, metadata = {}) {
  console.error(message);

  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== null) {
      console.error(`${key}: ${value}`);
    }
  }

  process.exit(1);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));

  return { response, payload };
}

async function main() {
  if (!sessionToken) {
    fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  }

  const input = parseArgs(process.argv.slice(2));
  const { response, payload } = await requestJson("/api/reconciliation/run", {
    method: "POST",
    body: JSON.stringify({
      runType: input.runType,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
      currency: input.currency,
    }),
  });

  if (!response.ok || !payload.success) {
    fail("Reconciliation run failed.", {
      status: response.status,
      error: payload.error ?? payload.errors?.join(" ") ?? "Unknown error",
      correlationId: payload.correlationId,
    });
  }

  const run = payload.run;
  const findings = payload.findings ?? [];
  const failCount = Number(run.failedChecks ?? 0);
  const warningCount = Number(run.warningChecks ?? 0);

  console.log("Reconciliation run completed.");
  console.log(`runId: ${run.id}`);
  console.log(`runType: ${run.runType}`);
  console.log(`status: ${run.status}`);
  console.log(`totalChecks: ${run.totalChecks}`);
  console.log(`passedChecks: ${run.passedChecks}`);
  console.log(`warningChecks: ${warningCount}`);
  console.log(`failedChecks: ${failCount}`);
  console.log(`correlationId: ${payload.correlationId ?? ""}`);

  const actionableFindings = findings.filter(
    (finding) => finding.severity === "WARNING" || finding.severity === "FAIL"
  );

  if (actionableFindings.length > 0) {
    console.log("Actionable findings:");

    for (const finding of actionableFindings.slice(0, 10)) {
      console.log(
        `${finding.severity} ${finding.checkCode} ${finding.entityType}:${finding.entityId} ${finding.message}`
      );
    }
  }

  if (failCount > 0 && !input.allowFail) {
    fail("Reconciliation produced FAIL severity findings.", {
      runId: run.id,
      failedChecks: failCount,
      allowFail: false,
    });
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Reconciliation operation failed.");
});
