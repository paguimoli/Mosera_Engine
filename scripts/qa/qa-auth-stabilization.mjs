import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  loadLocalEnv,
  sessionFilePath,
  validateSessionToken,
} from "./lib/qa-auth-session.mjs";

function run(script) {
  const result = spawnSync("npm", ["run", script], {
    encoding: "utf8",
    env: process.env,
  });

  return {
    script,
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function pass(message, metadata = {}) {
  console.log(JSON.stringify({ status: "PASS", message, ...metadata }, null, 2));
}

loadLocalEnv({ includeSession: false });

const bootstrap = run("qa:auth:bootstrap");
if (bootstrap.exitCode !== 0) {
  fail("QA auth bootstrap failed.", {
    bootstrap,
  });
}

loadLocalEnv();

if (!existsSync(sessionFilePath)) {
  fail("QA session file was not created.", { sessionFilePath });
}

const session = await validateSessionToken();
if (!session.valid) {
  fail("Auto-loaded QA session is not valid.", { session });
}
pass("Bootstrap and session auto-load work.", {
  expiresAt: session.expiresAt,
});

const status = run("qa:auth:status");
if (status.exitCode !== 0) {
  fail("QA auth status failed.", { status });
}
pass("QA auth status works.");

const authority = run("qa:authority-control");
if (authority.exitCode !== 0) {
  fail("Session auto-load did not satisfy authority QA.", { authority });
}
pass("Session auto-load satisfies protected QA.");

const qaAll = run("qa:all");
if (qaAll.exitCode !== 0) {
  fail("Composite QA runner failed.", { qaAll });
}
pass("Composite QA runner works.");
