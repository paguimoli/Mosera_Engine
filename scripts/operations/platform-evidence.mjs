const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function fail(message, metadata = {}) {
  console.error(message);

  for (const [key, value] of Object.entries(metadata)) {
    console.error(`${key}: ${value}`);
  }

  process.exit(1);
}

async function main() {
  if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

  const response = await fetch(`${appUrl}/api/operations/platform-evidence`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.success) {
    fail("Platform evidence endpoint failed.", {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  const report = payload.platformEvidence;

  console.log(`status: ${report.status}`);
  console.log(`blockers: ${report.blockers.length}`);
  console.log(`warnings: ${report.warnings.length}`);
  console.log(`ledgerReferenceAudit: ${report.ledgerReferenceAudit.status}`);
  console.log(`ledgerImmutability: ${report.ledgerImmutability.status}`);
  console.log(`outboxHealth: ${report.outboxHealth.recommendation}`);
  console.log(`queueHealth: ${report.queueHealth.recommendation}`);
  console.log(`workerHealth: ${report.workerHealth.recommendation}`);
  console.log(`generatedAt: ${report.generatedAt}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Platform evidence report failed.");
});
