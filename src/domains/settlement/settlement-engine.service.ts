import {
  type SettlementEvaluationInput,
  type SettlementEvaluationResult,
} from "./evaluators/settlement-evaluator.types";
import { evaluateTicketLine } from "./settlement-evaluator-router.service";

export { evaluateTicketLine } from "./settlement-evaluator-router.service";

export function evaluateTicketLines(
  inputs: SettlementEvaluationInput[]
): SettlementEvaluationResult[] {
  return inputs.map((input) => evaluateTicketLine(input));
}

export {
  executeSettlementRun,
  type SettlementExecutionInput,
  type SettlementExecutionResult,
  type SettlementExecutionSummary,
} from "./settlement-executor.service";
