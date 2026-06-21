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
  "qa:settlement-authority-dry-run",
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
