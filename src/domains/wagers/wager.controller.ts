import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import {
  deleteWagerOption,
  deleteWagerOptionsByTypeId,
  deleteWagerType,
  findWagerOptionById,
  findWagerTypeById,
  saveWagerOption,
  saveWagerType,
  updateWagerOption,
  updateWagerType,
} from "./wager.repository";
import {
  buildDefaultKenoWagers,
  buildWagerOptionPayload,
  buildWagerTypePayload,
} from "./wager.service";
import type { PayTable, WagerOption, WagerType } from "./wager.types";
import {
  validateWagerOptionForm,
  validateWagerTypeForm,
} from "./wager.validation";

export function saveWagerTypeController({
  form,
  wagerTypes,
  editingWagerTypeId,
}: {
  form: Parameters<typeof buildWagerTypePayload>[0]["form"];
  wagerTypes: WagerType[];
  editingWagerTypeId?: string | null;
}) {
  const validation = validateWagerTypeForm({
    form,
    wagerTypes,
    editingWagerTypeId,
  });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const existingWagerType = editingWagerTypeId
    ? findWagerTypeById(wagerTypes, editingWagerTypeId)
    : undefined;
  const result = buildWagerTypePayload({ form, existingWagerType });

  if (!result.ok || !result.payload) {
    return controllerFailure(result.message);
  }

  return controllerSuccess({
    wagerType: result.payload,
    wagerTypes: editingWagerTypeId
      ? updateWagerType(wagerTypes, result.payload)
      : saveWagerType(wagerTypes, result.payload),
  });
}

export function deleteWagerTypeController({
  wagerTypeId,
  wagerTypes,
  wagerOptions,
}: {
  wagerTypeId: string;
  wagerTypes: WagerType[];
  wagerOptions: WagerOption[];
}) {
  return controllerSuccess({
    wagerTypes: deleteWagerType(wagerTypes, wagerTypeId),
    wagerOptions: deleteWagerOptionsByTypeId(wagerOptions, wagerTypeId),
  });
}

export function saveWagerOptionController({
  form,
  wagerOptions,
  editingWagerOptionId,
}: {
  form: Parameters<typeof buildWagerOptionPayload>[0]["form"];
  wagerOptions: WagerOption[];
  editingWagerOptionId?: string | null;
}) {
  const validation = validateWagerOptionForm({
    form,
    wagerOptions,
    editingWagerOptionId,
  });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const existingOption = editingWagerOptionId
    ? findWagerOptionById(wagerOptions, editingWagerOptionId)
    : undefined;
  const result = buildWagerOptionPayload({ form, existingOption });

  if (!result.ok || !result.payload) {
    return controllerFailure(result.message);
  }

  return controllerSuccess({
    wagerOption: result.payload,
    wagerOptions: editingWagerOptionId
      ? updateWagerOption(wagerOptions, result.payload)
      : saveWagerOption(wagerOptions, result.payload),
  });
}

export function deleteWagerOptionController({
  optionId,
  wagerOptions,
}: {
  optionId: string;
  wagerOptions: WagerOption[];
}) {
  return controllerSuccess({
    wagerOptions: deleteWagerOption(wagerOptions, optionId),
  });
}

export function addDefaultKenoWagersController({
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
  const { nextWagerTypes, newDefaults, newOptions } = buildDefaultKenoWagers({
    gameId,
    wagerTypes,
    wagerOptions,
    payTables,
  });

  if (newDefaults.length === 0 && newOptions.length === 0) {
    return controllerFailure("Default wager types already exist for this game.");
  }

  return controllerSuccess({
    newDefaults,
    newOptions,
    wagerTypes: nextWagerTypes,
    wagerOptions: newOptions.reduce(
      (nextOptions, option) => saveWagerOption(nextOptions, option),
      wagerOptions
    ),
  });
}

export const createWagerTypeController = saveWagerTypeController;
export const updateWagerTypeController = saveWagerTypeController;
export const createWagerOptionController = saveWagerOptionController;
export const updateWagerOptionController = saveWagerOptionController;
