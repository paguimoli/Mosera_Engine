import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { LedgerServiceCompensationGateway } from "../../src/domains/compensation/compensation-ledger.gateway";
import type { CompensationEntitlement } from "../../src/domains/compensation/compensation.types";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const checks: string[] = [];
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  checks.push(message);
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const scope = await pool.query<{
      account_id: string;
      wallet_id: string;
      currency: string;
      tenant_id: string;
      brand_id: string;
      market_id: string;
      balance: string;
    }>(
      `select account.id as account_id, wallet.id as wallet_id,
              wallet.currency_code as currency, account.canonical_tenant_id as tenant_id,
              account.canonical_brand_id as brand_id,
              account.canonical_market_id as market_id, wallet.balance::text
         from public.accounts account
         join public.financial_wallets wallet
           on wallet.account_id = account.id
          and wallet.wallet_type = 'CREDIT'
          and wallet.status = 'ACTIVE'
        where account.governance_managed and account.status = 'ACTIVE'
        limit 1`
    );
    assert(scope.rowCount === 1, "A canonical CREDIT wallet is available.");
    const row = scope.rows[0];
    const gateway = new LedgerServiceCompensationGateway();
    const entitlementId = randomUUID();
    const entitlement: CompensationEntitlement = {
      id: entitlementId,
      executionId: randomUUID(),
      configurationId: randomUUID(),
      accountingPeriodId: randomUUID(),
      tenantId: row.tenant_id,
      brandId: row.brand_id,
      marketId: row.market_id,
      hierarchyOwnerAccountId: row.account_id,
      beneficiaryAccountId: row.account_id,
      strategy: "REBATE",
      reportingClassification: "REBATE",
      calculationBasis: "NET_LOSS",
      basisAmountMinor: 1_000,
      rateBasisPoints: 1_000,
      compensationAmountMinor: 100,
      currency: row.currency,
      fundingInstrument: "CREDIT",
      walletId: row.wallet_id,
      ledgerTransactionType: "PLAYER_REBATE_CREDIT",
      canonicalEntitlementHash: `sha256:${"1".repeat(64)}`,
      reversalOfEntitlementId: null,
      createdAt: new Date().toISOString(),
    };
    const first = await gateway.postEntitlement(entitlement);
    const duplicate = await gateway.postEntitlement(entitlement);
    assert(first.ledgerEntryId === duplicate.ledgerEntryId, "Ledger posting retry is idempotent.");

    const reversal = await gateway.reverseEntitlement(
      {
        ...entitlement,
        id: randomUUID(),
        canonicalEntitlementHash: `sha256:${"2".repeat(64)}`,
        reversalOfEntitlementId: entitlement.id,
        createdAt: new Date().toISOString(),
      },
      first.ledgerEntryId,
      first.canonicalRequestHash,
      "CORRECTION"
    );
    assert(Boolean(reversal.ledgerEntryId), "Governed compensation reversal succeeds.");
    const balance = await pool.query<{ balance: string }>(
      "select balance::text from public.financial_wallets where id = $1",
      [row.wallet_id]
    );
    assert(
      balance.rows[0].balance === row.balance,
      "Ledger posting and reversal produce opposing wallet effects."
    );
    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

