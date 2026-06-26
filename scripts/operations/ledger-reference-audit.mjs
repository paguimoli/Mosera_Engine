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

  const response = await fetch(`${appUrl}/api/operations/ledger-reference-audit`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.success) {
    fail("Ledger reference audit endpoint failed.", {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  const audit = payload.ledgerReferenceAudit;

  console.log(`status: ${audit.status}`);
  console.log(`sampledCreditBackedSettlements: ${audit.sampledCreditBackedSettlements}`);
  console.log(`matchedLedgerPostings: ${audit.matchedLedgerPostings}`);
  console.log(`directReferenceMatches: ${audit.directReferenceMatches}`);
  console.log(`inferredReferenceMatches: ${audit.inferredReferenceMatches}`);
  console.log(`missingLedgerPostingCount: ${audit.missingLedgerPostingCount}`);
  console.log(`orphanLedgerRecordCount: ${audit.orphanLedgerRecordCount}`);
  console.log(`issues: ${audit.issues.length}`);
  console.log(`generatedAt: ${audit.generatedAt}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Ledger reference audit failed.");
});
