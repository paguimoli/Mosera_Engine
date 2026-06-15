import { getDefaultBrand } from "../src/domains/brands/brand.repository";
import { getDefaultMarket } from "../src/domains/markets/market.repository";
import {
  createWeeklySummariesForPeriod,
  ensureOpenWeeklyPeriodForMarketBrand,
} from "../src/domains/weekly-accounting/weekly-accounting.service";

async function main() {
  const defaultMarket = await getDefaultMarket();
  const defaultBrand = await getDefaultBrand();

  if (!defaultMarket) {
    throw new Error("Default market is required before creating weekly summaries.");
  }

  if (!defaultBrand) {
    throw new Error("Default brand is required before creating weekly summaries.");
  }

  const period = await ensureOpenWeeklyPeriodForMarketBrand(
    defaultMarket.id,
    defaultBrand.id
  );
  const summaries = await createWeeklySummariesForPeriod(period.id);

  console.log("Weekly account summaries ready.");
  console.log(`Period: ${period.periodStartAt} -> ${period.periodEndAt}`);
  console.log(`Summary count: ${summaries.length}`);
}

main().catch((error: unknown) => {
  console.error("Supabase weekly summaries script error:", error);
  console.error(
    error instanceof Error
      ? error.message
      : "Weekly summaries script failed."
  );
  process.exit(1);
});
