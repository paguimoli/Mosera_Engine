import type { WagerOption, WagerType } from "./wager.types";

export function findWagerTypeById(wagerTypes: WagerType[], wagerTypeId: string) {
  return wagerTypes.find((wagerType) => wagerType.id === wagerTypeId);
}

export function findWagerOptionById(
  wagerOptions: WagerOption[],
  optionId: string
) {
  return wagerOptions.find((option) => option.id === optionId);
}

export function saveWagerType(wagerTypes: WagerType[], wagerType: WagerType) {
  return [...wagerTypes, wagerType];
}

export function updateWagerType(wagerTypes: WagerType[], wagerType: WagerType) {
  return wagerTypes.map((createdWagerType) =>
    createdWagerType.id === wagerType.id ? wagerType : createdWagerType
  );
}

export function deleteWagerType(wagerTypes: WagerType[], wagerTypeId: string) {
  return wagerTypes.filter((wagerType) => wagerType.id !== wagerTypeId);
}

export function saveWagerOption(
  wagerOptions: WagerOption[],
  wagerOption: WagerOption
) {
  return [...wagerOptions, wagerOption];
}

export function updateWagerOption(
  wagerOptions: WagerOption[],
  wagerOption: WagerOption
) {
  return wagerOptions.map((createdOption) =>
    createdOption.id === wagerOption.id ? wagerOption : createdOption
  );
}

export function deleteWagerOption(wagerOptions: WagerOption[], optionId: string) {
  return wagerOptions.filter((option) => option.id !== optionId);
}

export function listWagerOptionsByTypeId(
  wagerOptions: WagerOption[],
  wagerTypeId: string
) {
  return wagerOptions.filter((option) => option.wagerTypeId === wagerTypeId);
}

export function deleteWagerOptionsByTypeId(
  wagerOptions: WagerOption[],
  wagerTypeId: string
) {
  return wagerOptions.filter((option) => option.wagerTypeId !== wagerTypeId);
}
