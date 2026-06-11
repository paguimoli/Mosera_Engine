import { evaluateBullseye } from "./evaluators/bullseye.evaluator";
import { evaluateDragonTiger } from "./evaluators/dragon-tiger.evaluator";
import { evaluateElement } from "./evaluators/element.evaluator";
import { evaluateHitCount } from "./evaluators/hit-count.evaluator";
import { evaluateMetricComparison } from "./evaluators/metric-comparison.evaluator";
import { evaluateMetricThreshold } from "./evaluators/metric-threshold.evaluator";
import { evaluateSelectionMatch } from "./evaluators/selection-match.evaluator";
import {
  failedResult,
  type SettlementEvaluationInput,
  type SettlementEvaluationResult,
} from "./evaluators/settlement-evaluator.types";
import { evaluateUpDown } from "./evaluators/up-down.evaluator";

export function evaluateTicketLine(
  input: SettlementEvaluationInput
): SettlementEvaluationResult {
  const settlementMethod: string = input.wagerType.settlementMethod;

  if (settlementMethod === "hit_count") {
    return evaluateHitCount(input);
  }

  if (settlementMethod === "hit_count_bullseye") {
    return evaluateBullseye(input);
  }

  if (settlementMethod === "metric_threshold") {
    return evaluateMetricThreshold(input);
  }

  if (settlementMethod === "metric_comparison") {
    return evaluateMetricComparison(input);
  }

  if (settlementMethod === "dragon_tiger") {
    return evaluateDragonTiger(input);
  }

  if (settlementMethod === "up_down") {
    return evaluateUpDown(input);
  }

  if (settlementMethod === "element_count") {
    return evaluateElement(input);
  }

  if (settlementMethod === "selection_match") {
    return evaluateSelectionMatch(input);
  }

  return failedResult({
    reason: `Unsupported settlement method: ${settlementMethod}`,
    metadata: { settlementMethod },
  });
}
