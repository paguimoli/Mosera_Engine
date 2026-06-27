import { spawnSync } from "node:child_process";
import { loadLocalEnv } from "./lib/qa-auth-session.mjs";

loadLocalEnv();

const steps = [
  "qa:auth:bootstrap",
  "qa:authority-control",
  "qa:settlement-authority",
  "qa:shadow-readiness",
  "qa:shadow-analysis",
  "qa:shadow-evidence-lifecycle",
  "qa:promotion-decision",
  "qa:dry-run-approval",
  "qa:promotion-approval",
  "qa:promotion-simulation",
  "qa:settlement-promotion",
  "qa:settlement-post-promotion",
  "qa:rollback-trigger-alignment",
  "qa:settlement-stabilization",
  "qa:settlement-post-promotion-activity",
  "qa:settlement-certification",
  "qa:settlement-authority-dry-run",
  "qa:ledger-authority",
  "qa:ledger-shadow-analysis",
  "qa:ledger-lifecycle",
  "qa:ledger-promotion-decision",
  "qa:ledger-dry-run-approval",
  "qa:ledger-promotion-approval",
  "qa:ledger-dry-run",
  "qa:ledger-promotion-simulation",
  "qa:ledger-promotion-execution",
  "qa:ledger-post-promotion",
  "qa:ledger-post-promotion-activity",
  "qa:ledger-certification",
  "qa:credit-authority",
  "qa:credit-shadow-analysis",
  "qa:credit-lifecycle",
  "qa:credit-promotion-decision",
  "qa:credit-dry-run-approval",
  "qa:credit-promotion-approval",
  "qa:credit-dry-run",
  "qa:credit-promotion-simulation",
  "qa:credit-promotion-execution",
  "qa:credit-post-promotion",
  "qa:credit-post-promotion-activity",
  "qa:credit-certification",
  "qa:post-extraction-golden-path",
  "qa:post-extraction-hardening",
  "qa:evidence-hardening",
  "qa:ledger-remediation-hardening",
  "qa:credit-launch",
  "qa:worker-observability",
];
const results = [];

for (const script of steps) {
  const result = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    env: process.env,
  });

  results.push({
    script,
    exitCode: result.status ?? 1,
  });

  if (result.status !== 0) {
    break;
  }

  loadLocalEnv();
}

const failed = results.filter((result) => result.exitCode !== 0);

console.log(
  JSON.stringify(
    {
      status: failed.length === 0 ? "PASS" : "FAIL",
      results,
    },
    null,
    2
  )
);

process.exit(failed.length === 0 ? 0 : 1);
