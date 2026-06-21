import { spawnSync } from "node:child_process";

import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function pass(message, metadata = {}) {
  console.log(JSON.stringify({ status: "PASS", message, ...metadata }, null, 2));
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

async function authGet(path) {
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required.");
  }

  return requestJson(path, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}

async function getAnalysis() {
  const [summary, mismatches, failures] = await Promise.all([
    authGet("/api/shadow-analysis/summary?window=all"),
    authGet("/api/shadow-analysis/mismatches?window=all"),
    authGet("/api/shadow-analysis/failures?window=all"),
  ]);

  assert(
    summary.response.status === 200 && summary.body.success,
    "Shadow analysis summary endpoint failed.",
    { status: summary.response.status, body: summary.body }
  );
  assert(
    mismatches.response.status === 200 && mismatches.body.success,
    "Shadow analysis mismatches endpoint failed.",
    { status: mismatches.response.status, body: mismatches.body }
  );
  assert(
    failures.response.status === 200 && failures.body.success,
    "Shadow analysis failures endpoint failed.",
    { status: failures.response.status, body: failures.body }
  );

  return {
    summary: summary.body.analysis,
    mismatches: mismatches.body.mismatches,
    failures: failures.body.failures,
  };
}

function countClass(items, evidenceClass) {
  return items.filter((item) => item.evidenceClass === evidenceClass).length;
}

function seedIntentionalEvidenceIfNeeded({ mismatches, failures }) {
  const hasIntentionalMismatch =
    countClass(mismatches, "QA_INTENTIONAL_MISMATCH") > 0;
  const hasIntentionalFailure =
    countClass(failures, "QA_INTENTIONAL_FAILURE") > 0;

  if (hasIntentionalMismatch && hasIntentionalFailure) return;

  const scripts = [
    "qa:settlement-shadow-reporting",
    "qa:ledger-shadow-reporting",
    "qa:credit-shadow-reporting",
  ];

  for (const script of scripts) {
    const result = spawnSync("npm", ["run", script], {
      stdio: "inherit",
      env: process.env,
    });

    if (result.status !== 0) {
      fail("Unable to seed intentional shadow analysis evidence.", {
        script,
        exitCode: result.status ?? 1,
      });
    }
  }
}

const unauthenticated = await requestJson("/api/shadow-analysis/summary");
assert(
  unauthenticated.response.status === 401,
  "Shadow analysis summary endpoint should require authentication.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Protected endpoint requires auth.");

let analysis = await getAnalysis();
seedIntentionalEvidenceIfNeeded(analysis);
analysis = await getAnalysis();

const intentionalMismatches = countClass(
  analysis.mismatches,
  "QA_INTENTIONAL_MISMATCH"
);
const intentionalFailures = countClass(
  analysis.failures,
  "QA_INTENTIONAL_FAILURE"
);

assert(
  intentionalMismatches > 0,
  "Intentional QA mismatches were not classified correctly.",
  { mismatchClasses: analysis.summary.rootCause.mismatchCountsByCategory }
);
assert(
  intentionalFailures > 0,
  "Intentional QA failures were not classified correctly.",
  { failureClasses: analysis.summary.rootCause.failureCountsByCategory }
);
pass("Intentional QA evidence classified correctly.", {
  intentionalMismatches,
  intentionalFailures,
});

assert(analysis.summary.platform.raw.readiness, "Raw readiness missing.", {
  platform: analysis.summary.platform,
});
assert(
  analysis.summary.platform.adjusted.readiness,
  "Adjusted readiness missing.",
  { platform: analysis.summary.platform }
);
assert(
  analysis.summary.platform.adjusted.mismatchRate <=
    analysis.summary.platform.raw.mismatchRate,
  "Adjusted mismatch rate should not exceed raw mismatch rate.",
  { platform: analysis.summary.platform }
);
assert(
  analysis.summary.platform.adjusted.failureRate <=
    analysis.summary.platform.raw.failureRate,
  "Adjusted failure rate should not exceed raw failure rate.",
  { platform: analysis.summary.platform }
);
pass("Adjusted readiness calculated without mutating raw readiness.", {
  raw: analysis.summary.platform.raw,
  adjusted: analysis.summary.platform.adjusted,
});

for (const domain of ["settlement", "ledger", "credit"]) {
  assert(analysis.summary.domains[domain], "Domain breakdown missing.", {
    domain,
    summary: analysis.summary,
  });
}
pass("Reports generated for all shadow domains.", {
  recommendation: analysis.summary.recommendation,
});

pass("Shadow analysis QA completed.", {
  raw: analysis.summary.platform.raw,
  adjusted: analysis.summary.platform.adjusted,
  recommendation: analysis.summary.recommendation,
});
