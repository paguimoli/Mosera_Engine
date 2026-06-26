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

  const response = await fetch(`${appUrl}/api/operations/ledger-immutability`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.success) {
    fail("Ledger immutability endpoint failed.", {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  const report = payload.ledgerImmutability;

  console.log(`status: ${report.status}`);
  console.log(`ledgerEntryCount: ${report.ledgerEntryCount}`);
  console.log(`updateDetection: ${report.updateDetection.status}`);
  console.log(`deleteDetection: ${report.deleteDetection.status}`);
  console.log(`reversalIntegrity: ${report.reversalIntegrity.status}`);
  console.log(`adjustmentChains: ${report.adjustmentChains.status}`);
  console.log(`databaseTriggers: ${report.databaseTriggers.status}`);
  console.log(`warnings: ${report.warnings.length}`);
  console.log(`generatedAt: ${report.generatedAt}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Ledger immutability report failed.");
});
