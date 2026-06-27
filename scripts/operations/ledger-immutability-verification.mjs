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

  const response = await fetch(`${appUrl}/api/operations/ledger-immutability-verification`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.success) {
    fail("Ledger immutability verification endpoint failed.", {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  const report = payload.immutabilityVerification;

  console.log(`status: ${report.status}`);
  console.log(`enforcementMode: ${report.enforcementMode}`);
  console.log(`destructiveProbeAttempted: ${report.destructiveProbeAttempted}`);
  console.log(`destructiveTriggerCreated: ${report.destructiveTriggerCreated}`);
  console.log(`updateProtected: ${report.guarantees.updateImpossibleOrProtected}`);
  console.log(`deleteProtected: ${report.guarantees.deleteImpossibleOrProtected}`);
  console.log(`appendOnlyEnforced: ${report.guarantees.appendOnlyEnforced}`);
  console.log(`reversalChainIntact: ${report.guarantees.reversalChainIntact}`);
  console.log(`adjustmentChainIntact: ${report.guarantees.adjustmentChainIntact}`);
  console.log(`generatedAt: ${report.generatedAt}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Ledger immutability verification failed.");
});
