import {
  createMarket,
  setDefaultMarket,
  updateMarket,
} from "../src/domains/markets/market.service";
import { findMarketByCode } from "../src/domains/markets/market.repository";

const DEFAULT_MARKET = {
  code: "CR",
  name: "Costa Rica",
  currencyCode: "CRC",
  languageCode: "es",
  timezone: "America/Costa_Rica",
  brandCode: "MAIN",
  status: "ACTIVE" as const,
  isDefault: true,
};

async function main() {
  const existingMarket = await findMarketByCode(DEFAULT_MARKET.code);
  const market = existingMarket
    ? await updateMarket(existingMarket.id, DEFAULT_MARKET)
    : await createMarket(DEFAULT_MARKET);
  const defaultMarket = await setDefaultMarket(market.id);

  console.log("Default market seeded successfully.");
  console.log(`Code: ${defaultMarket.code}`);
  console.log(`Name: ${defaultMarket.name}`);
}

main().catch((error: unknown) => {
  console.error("Supabase market seed error:", error);
  console.error(
    error instanceof Error ? error.message : "Default market seed failed."
  );
  process.exit(1);
});
