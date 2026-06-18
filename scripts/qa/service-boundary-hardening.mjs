import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function fail(message, metadata = {}) {
  console.error(
    JSON.stringify(
      {
        status: "FAIL",
        message,
        ...metadata,
      },
      null,
      2
    )
  );
  process.exit(1);
}

function pass(message, metadata = {}) {
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        message,
        ...metadata,
      },
      null,
      2
    )
  );
}

function readRelative(relativePath) {
  const absolutePath = path.join(root, relativePath);

  if (!fs.existsSync(absolutePath)) {
    fail("Required service boundary artifact is missing.", { path: relativePath });
  }

  return fs.readFileSync(absolutePath, "utf8");
}

function assertContains(relativePath, expectedValues) {
  const contents = readRelative(relativePath);
  const missing = expectedValues.filter((value) => !contents.includes(value));

  if (missing.length > 0) {
    fail("Service boundary artifact is missing expected exports or content.", {
      path: relativePath,
      missing,
    });
  }

  pass("Service boundary artifact validated.", { path: relativePath });
}

function walkFiles(directory, files = []) {
  const absoluteDirectory = path.join(root, directory);

  if (!fs.existsSync(absoluteDirectory)) {
    return files;
  }

  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const relativePath = path.relative(root, absolutePath);

    if (entry.isDirectory()) {
      walkFiles(relativePath, files);
      continue;
    }

    if (/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(entry.name)) {
      files.push(relativePath);
    }
  }

  return files;
}

function assertNoForbiddenRepositoryImports() {
  const scannedFiles = [...walkFiles("app/api"), ...walkFiles("scripts/workers")];
  const forbiddenPattern =
    /from\s+["'][^"']*domains\/(?:ledger|credit|settlement)\/[^"']*repository["']/;
  const violations = [];

  for (const file of scannedFiles) {
    const contents = fs.readFileSync(path.join(root, file), "utf8");

    if (forbiddenPattern.test(contents)) {
      violations.push(file);
    }
  }

  if (violations.length > 0) {
    fail("Route or worker imports a domain repository directly.", {
      violations,
    });
  }

  pass("No forbidden Ledger/Credit/Settlement repository imports found.", {
    scannedFileCount: scannedFiles.length,
  });
}

assertContains("src/domains/ledger/ledger.entrypoints.ts", [
  "postLedgerEntry",
  "reverseLedgerEntry",
  "getLedgerTransaction",
  "getLedgerAuditTrail",
]);

assertContains("src/domains/credit/credit.entrypoints.ts", [
  "reserveCreditExposure",
  "releaseCreditExposure",
  "applyCreditSettlement",
  "getPlayerCreditSummary",
  "cancelCreditReservation",
]);

assertContains("src/domains/settlement/settlement.entrypoints.ts", [
  "executeSettlement",
  "resumeSettlement",
  "applySettlementResults",
  "reverseSettlementRecordsForResettlement",
]);

assertContains("docs/architecture/service-contract-ledger.md", [
  "Post Ledger Entry",
  "Reverse Ledger Entry",
  "Get Ledger Transaction",
]);

assertContains("docs/architecture/service-contract-credit-wallet.md", [
  "Reserve Exposure",
  "Release Exposure",
  "Apply Credit Settlement",
]);

assertContains("docs/architecture/service-contract-settlement.md", [
  "Execute Settlement",
  "Resume Settlement",
  "Apply Settlement Results",
]);

assertNoForbiddenRepositoryImports();

pass("Service boundary hardening QA completed.");
