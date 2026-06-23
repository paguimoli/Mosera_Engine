import fs from "node:fs";
import path from "node:path";

import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function readArgs(argv) {
  const args = {
    correlationId: `ops-ledger-promote-${Date.now()}`,
    justification: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--justification" && next) {
      args.justification = next;
      index += 1;
    } else if (arg === "--correlation-id" && next) {
      args.correlationId = next;
      index += 1;
    } else if (arg.startsWith("--correlation-id=")) {
      args.correlationId = arg.split("=").slice(1).join("=");
    }
  }

  return args;
}

function updateLocalEnv() {
  const envPath = path.resolve(".env.local");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const updates = new Map([
    ["LEDGER_AUTHORITY", "SERVICE"],
    ["LEDGER_COMPARISON_MODE", "ENABLED"],
  ]);
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !updates.has(match[1])) return line;

    seen.add(match[1]);
    return `${match[1]}=${updates.get(match[1])}`;
  });

  for (const [key, value] of updates) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(
    envPath,
    `${nextLines
      .filter((line, index) => line !== "" || index < nextLines.length - 1)
      .join("\n")}\n`
  );
}

if (!sessionToken) {
  console.error("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const args = readArgs(process.argv.slice(2));
if (!args.justification.trim()) {
  console.error("--justification is required.");
  process.exit(1);
}

const response = await fetch(`${appUrl}/api/authority/ledger-promotion/execute`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${sessionToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    domain: "LEDGER",
    mode: "EXECUTE",
    justification: args.justification,
    correlationId: args.correlationId,
  }),
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  console.error(
    JSON.stringify({ status: "FAIL", statusCode: response.status, payload }, null, 2)
  );
  process.exit(1);
}

updateLocalEnv();

const promotion = payload.promotion;

console.log(
  JSON.stringify(
    {
      status: "PASS",
      domain: promotion.domain,
      previousAuthority: promotion.previousAuthority,
      newAuthority: promotion.newAuthority,
      comparisonMode: promotion.comparisonMode,
      rollbackReadiness: promotion.rollbackReadiness,
      promotionApprovalId: promotion.promotionApprovalId,
      promotedAt: promotion.promotedAt,
      correlationId: promotion.correlationId,
      idempotent: promotion.idempotent,
      auditEvent: promotion.auditEvent,
      persistedLocalConfig: ".env.local",
    },
    null,
    2
  )
);
