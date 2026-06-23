import {
  getSettlementShadowFailures,
  getSettlementShadowMismatches,
  getSettlementShadowRuns,
} from "../settlement-shadow/settlement-shadow-reporting.service";
import type { SettlementShadowListFilters } from "../settlement-shadow/settlement-shadow.types";

export async function getSettlementStabilizationEvidence(
  filters: SettlementShadowListFilters
) {
  const [runs, mismatches, failures] = await Promise.all([
    getSettlementShadowRuns(filters),
    getSettlementShadowMismatches(filters),
    getSettlementShadowFailures(filters),
  ]);

  return {
    runs,
    mismatches,
    failures,
  };
}
