import { invalid, valid } from "@/src/lib/validation/validation.types";
import { COMPARISON_OPERATORS } from "./wager.types";
import type { ComparisonOperator, WagerOption, WagerType } from "./wager.types";
import {
  methodNeedsMetricKey,
  methodNeedsOperator,
  methodNeedsThreshold,
} from "./wager.service";

export function normalizeWagerCode(code: string) {
  return code.trim().toLowerCase().replace(/\s+/g, "_");
}

export function validateWagerTypeForm({
  form,
  wagerTypes,
  editingWagerTypeId,
}: {
  form: {
    gameId: string;
    name: string;
    code: string;
    settlementMethod: string;
    metricKey: string;
    comparisonOperator: string;
    thresholdValue: string;
  };
  wagerTypes: WagerType[];
  editingWagerTypeId?: string | null;
}) {
  const code = normalizeWagerCode(form.code);
  const settlementMethod = form.settlementMethod;

  if (!form.gameId || !form.name.trim() || !code || !settlementMethod) {
    return invalid(
      "Please select a game, name the wager type, enter a code, and choose a settlement method."
    );
  }

  if (
    wagerTypes.some(
      (wagerType) =>
        wagerType.id !== editingWagerTypeId &&
        wagerType.gameId === form.gameId &&
        wagerType.code === code
    )
  ) {
    return invalid("A wager type with this code already exists for this game.");
  }

  if (methodNeedsMetricKey(settlementMethod) && !form.metricKey) {
    return invalid("Please select a metric key for this settlement method.");
  }

  if (methodNeedsOperator(settlementMethod) && !form.comparisonOperator) {
    return invalid("Please select a comparison operator for this settlement method.");
  }

  if (
    methodNeedsOperator(settlementMethod) &&
    !COMPARISON_OPERATORS.includes(form.comparisonOperator as ComparisonOperator)
  ) {
    return invalid("Please select a valid comparison operator for this settlement method.");
  }

  if (methodNeedsThreshold(settlementMethod) && form.thresholdValue === "") {
    return invalid("Please enter a threshold value for this settlement method.");
  }

  return valid();
}

export function validateWagerOptionForm({
  form,
  wagerOptions,
  editingWagerOptionId,
}: {
  form: {
    wagerTypeId: string;
    name: string;
    code: string;
  };
  wagerOptions: WagerOption[];
  editingWagerOptionId?: string | null;
}) {
  const code = normalizeWagerCode(form.code);

  if (!form.wagerTypeId || !form.name.trim() || !code) {
    return invalid("Please select a wager type, name the option, and enter a code.");
  }

  if (
    wagerOptions.some(
      (option) =>
        option.id !== editingWagerOptionId &&
        option.wagerTypeId === form.wagerTypeId &&
        option.code === code
    )
  ) {
    return invalid("An option with this code already exists for this wager type.");
  }

  return valid();
}
