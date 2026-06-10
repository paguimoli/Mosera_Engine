import { COMPARISON_OPERATORS } from "./wager.types";
import type {
  ComparisonOperator,
  PayTable,
  SettlementMethod,
  WagerOption,
  WagerType,
} from "./wager.types";

export function methodNeedsMetricKey(method: string) {
  return (
    method === "metric_comparison" ||
    method === "metric_threshold" ||
    method === "element_count"
  );
}

export function methodNeedsOperator(method: string) {
  return method === "metric_comparison" || method === "metric_threshold";
}

export function methodNeedsThreshold(method: string) {
  return method === "metric_threshold";
}

export function methodUsesPayTable(method: string) {
  return method === "hit_count" || method === "hit_count_bullseye";
}

export function buildWagerTypePayload({
  form,
  existingWagerType,
}: {
  form: {
    gameId: string;
    name: string;
    code: string;
    settlementMethod: string;
    metricKey: string;
    comparisonOperator: string;
    thresholdValue: string;
    payTableId: string;
    active: boolean;
  };
  existingWagerType?: WagerType;
}) {
  const settlementMethod = form.settlementMethod as SettlementMethod;
  const code = form.code.trim().toLowerCase().replace(/\s+/g, "_");

  if (!form.gameId || !form.name.trim() || !code || !settlementMethod) {
    return {
      ok: false,
      message:
        "Please select a game, name the wager type, enter a code, and choose a settlement method.",
      payload: null,
      code,
    };
  }

  if (methodNeedsMetricKey(settlementMethod) && !form.metricKey) {
    return {
      ok: false,
      message: "Please select a metric key for this settlement method.",
      payload: null,
      code,
    };
  }

  if (methodNeedsOperator(settlementMethod) && !form.comparisonOperator) {
    return {
      ok: false,
      message: "Please select a comparison operator for this settlement method.",
      payload: null,
      code,
    };
  }

  if (
    methodNeedsOperator(settlementMethod) &&
    !COMPARISON_OPERATORS.includes(form.comparisonOperator as ComparisonOperator)
  ) {
    return {
      ok: false,
      message: "Please select a valid comparison operator for this settlement method.",
      payload: null,
      code,
    };
  }

  if (methodNeedsThreshold(settlementMethod) && form.thresholdValue === "") {
    return {
      ok: false,
      message: "Please enter a threshold value for this settlement method.",
      payload: null,
      code,
    };
  }

  return {
    ok: true,
    message: "",
    code,
    payload: {
      id: existingWagerType?.id || `WAGER-${Date.now()}`,
      gameId: form.gameId,
      name: form.name.trim(),
      code,
      active: form.active,
      settlementMethod,
      metricKey: methodNeedsMetricKey(settlementMethod) ? form.metricKey : undefined,
      comparisonOperator: methodNeedsOperator(settlementMethod)
        ? (form.comparisonOperator as ComparisonOperator)
        : undefined,
      thresholdValue: methodNeedsThreshold(settlementMethod)
        ? Number(form.thresholdValue)
        : null,
      payTableId: methodUsesPayTable(settlementMethod)
        ? form.payTableId || null
        : null,
      createdAt: existingWagerType?.createdAt || new Date().toISOString(),
    } satisfies WagerType,
  };
}

export function buildWagerOptionPayload({
  form,
  existingOption,
}: {
  form: {
    wagerTypeId: string;
    name: string;
    code: string;
    active: boolean;
  };
  existingOption?: WagerOption;
}) {
  const code = form.code.trim().toLowerCase().replace(/\s+/g, "_");

  if (!form.wagerTypeId || !form.name.trim() || !code) {
    return {
      ok: false,
      message: "Please select a wager type, name the option, and enter a code.",
      payload: null,
      code,
    };
  }

  return {
    ok: true,
    message: "",
    code,
    payload: {
      id: existingOption?.id || `OPTION-${Date.now()}`,
      wagerTypeId: form.wagerTypeId,
      name: form.name.trim(),
      code,
      active: form.active,
    } satisfies WagerOption,
  };
}

export function buildDefaultKenoWagers({
  gameId,
  wagerTypes,
  wagerOptions,
  payTables,
}: {
  gameId: string;
  wagerTypes: WagerType[];
  wagerOptions: WagerOption[];
  payTables: PayTable[];
}) {
  const activePayTable = payTables.find(
    (payTable) => payTable.gameId === gameId && payTable.active
  );
  const categoryDefaults: Array<
    Omit<WagerType, "id" | "gameId" | "active" | "createdAt">
  > = [
    {
      name: "Standard Spots",
      code: "standard_spots",
      settlementMethod: "hit_count",
      payTableId: activePayTable?.id || null,
    },
    {
      name: "Bullseye",
      code: "bullseye",
      settlementMethod: "hit_count_bullseye",
      payTableId: activePayTable?.id || null,
    },
    {
      name: "Dragon/Tiger",
      code: "dragon_tiger",
      settlementMethod: "dragon_tiger",
    },
    {
      name: "Up/Down",
      code: "up_down",
      settlementMethod: "selection_match",
    },
    {
      name: "Odd/Even",
      code: "odd_even",
      settlementMethod: "selection_match",
    },
    {
      name: "Big/Small",
      code: "big_small",
      settlementMethod: "selection_match",
    },
    {
      name: "Elements",
      code: "elements",
      settlementMethod: "element_count",
      metricKey: "woodCount",
    },
  ];
  const optionDefaults = [
    { wagerTypeCode: "standard_spots", name: "Standard", code: "standard" },
    { wagerTypeCode: "bullseye", name: "Bullseye", code: "bullseye" },
    { wagerTypeCode: "dragon_tiger", name: "Dragon", code: "dragon" },
    { wagerTypeCode: "dragon_tiger", name: "Tiger", code: "tiger" },
    { wagerTypeCode: "dragon_tiger", name: "DT-Tie", code: "dt_tie" },
    { wagerTypeCode: "up_down", name: "Up", code: "up" },
    { wagerTypeCode: "up_down", name: "Down", code: "down" },
    { wagerTypeCode: "up_down", name: "UD-Tie", code: "ud_tie" },
    { wagerTypeCode: "odd_even", name: "Odd", code: "odd" },
    { wagerTypeCode: "odd_even", name: "Even", code: "even" },
    { wagerTypeCode: "big_small", name: "Big", code: "big" },
    { wagerTypeCode: "big_small", name: "Small", code: "small" },
    { wagerTypeCode: "elements", name: "Wood", code: "wood" },
    { wagerTypeCode: "elements", name: "Fire", code: "fire" },
    { wagerTypeCode: "elements", name: "Earth", code: "earth" },
    { wagerTypeCode: "elements", name: "Metal", code: "metal" },
    { wagerTypeCode: "elements", name: "Water", code: "water" },
  ];
  const existingCodes = new Set(
    wagerTypes
      .filter((wagerType) => wagerType.gameId === gameId)
      .map((wagerType) => wagerType.code)
  );
  const createdAt = new Date().toISOString();
  const createdIdSeed = Date.now();
  const newDefaults = categoryDefaults
    .filter((defaultType) => !existingCodes.has(defaultType.code))
    .map((defaultType, index) => ({
      id: `WAGER-${createdIdSeed}-${index}`,
      gameId,
      active: true,
      createdAt,
      thresholdValue: null,
      payTableId: null,
      ...defaultType,
    }));
  const nextWagerTypes = [...wagerTypes, ...newDefaults];
  const wagerTypeByCode = new Map(
    nextWagerTypes
      .filter((wagerType) => wagerType.gameId === gameId)
      .map((wagerType) => [wagerType.code, wagerType])
  );
  const newOptions = optionDefaults
    .map((defaultOption, index) => {
      const parentWagerType = wagerTypeByCode.get(defaultOption.wagerTypeCode);

      if (!parentWagerType) {
        return null;
      }

      const optionExists = wagerOptions.some(
        (option) =>
          option.wagerTypeId === parentWagerType.id &&
          option.code === defaultOption.code
      );

      if (optionExists) {
        return null;
      }

      return {
        id: `OPTION-${createdIdSeed}-${index}`,
        wagerTypeId: parentWagerType.id,
        name: defaultOption.name,
        code: defaultOption.code,
        active: true,
      };
    })
    .filter(Boolean) as WagerOption[];

  return {
    nextWagerTypes,
    newOptions,
    newDefaults,
  };
}
