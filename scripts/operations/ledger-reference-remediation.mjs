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

  const response = await fetch(`${appUrl}/api/operations/ledger-reference-remediation`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.success) {
    fail("Ledger reference remediation endpoint failed.", {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  const report = payload.remediationReport;

  console.log(`status: ${report.status}`);
  console.log(`reportId: ${report.reportId}`);
  console.log(`appendOnly: ${report.appendOnly}`);
  console.log(`persisted: ${report.persistence.persisted}`);
  console.log(`items: ${report.itemCount}`);
  console.log(`highConfidence: ${report.highConfidenceCount}`);
  console.log(`mediumConfidence: ${report.mediumConfidenceCount}`);
  console.log(`lowConfidence: ${report.lowConfidenceCount}`);
  console.log(`unknownConfidence: ${report.unknownConfidenceCount}`);
  console.log(`generatedAt: ${report.generatedAt}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Ledger reference remediation failed.");
});
