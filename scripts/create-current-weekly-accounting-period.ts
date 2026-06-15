import { getDefaultBrand } from "../src/domains/brands/brand.repository";
import { getDefaultMarket } from "../src/domains/markets/market.repository";
import { ensureOpenWeeklyPeriodForMarketBrand } from "../src/domains/weekly-accounting/weekly-accounting.service";

async function main() {
  const defaultMarket = await getDefaultMarket();
  const defaultBrand = await getDefaultBrand();

  if (!defaultMarket) {
    throw new Error("Default market is required before creating weekly period.");
  }

  if (!defaultBrand) {
    throw new Error("Default brand is required before creating weekly period.");
  }

  const period = await ensureOpenWeeklyPeriodForMarketBrand(
    defaultMarket.id,
    defaultBrand.id
  );

  console.log("Current weekly accounting period ready.");
  console.log(`Market: ${defaultMarket.code}`);
  console.log(`Brand: ${defaultBrand.code}`);
  console.log(`Period: ${period.periodStartAt} -> ${period.periodEndAt}`);
  console.log(`Status: ${period.status}`);
}

main().catch((error: unknown) => {
  console.error("Supabase weekly period script error:", error);
  console.error(
    error instanceof Error
      ? error.message
      : "Current weekly accounting period script failed."
  );
  process.exit(1);
});
