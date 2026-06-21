import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;
const windowArg = process.argv.find((arg) => arg.startsWith("--window="));
const window = windowArg?.split("=")[1] || "7d";

if (!sessionToken) {
  console.error("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const response = await fetch(
  `${appUrl}/api/shadow-analysis/mismatches?window=${encodeURIComponent(window)}`,
  {
    headers: { authorization: `Bearer ${sessionToken}` },
  }
);
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  console.error(
    JSON.stringify({ status: "FAIL", statusCode: response.status, payload }, null, 2)
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      window,
      count: payload.mismatches.length,
      mismatches: payload.mismatches,
    },
    null,
    2
  )
);
