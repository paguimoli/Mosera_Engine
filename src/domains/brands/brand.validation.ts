import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { ValidationResult } from "@/src/lib/validation/validation.types";
import type { BrandStatus, CreateBrandInput, UpdateBrandInput } from "./brand.types";

const BRAND_STATUSES: BrandStatus[] = ["ACTIVE", "DISABLED"];

function isBrandStatus(value: string): value is BrandStatus {
  return BRAND_STATUSES.includes(value as BrandStatus);
}

export function normalizeBrandCode(code: string): string {
  return code.trim().toUpperCase();
}

export function validateCreateBrandInput(input: CreateBrandInput): ValidationResult {
  const errors: string[] = [];
  const code = normalizeBrandCode(input.code);
  const name = input.name.trim();
  const displayName = input.displayName.trim();
  const status = input.status ?? "ACTIVE";

  if (!code) {
    errors.push("Brand code is required.");
  }

  if (!name) {
    errors.push("Brand name is required.");
  }

  if (!displayName) {
    errors.push("Brand display name is required.");
  }

  if (!isBrandStatus(status)) {
    errors.push("Brand status is invalid.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}

export function validateUpdateBrandInput(input: UpdateBrandInput): ValidationResult {
  const validation = validateCreateBrandInput({
    code: input.code ?? "PATCH",
    name: input.name ?? "Patch",
    displayName: input.displayName ?? "Patch",
    status: input.status ?? "ACTIVE",
    isDefault: input.isDefault,
  });

  return validation;
}

export function normalizeCreateBrandInput(
  input: CreateBrandInput
): CreateBrandInput {
  return {
    code: normalizeBrandCode(input.code),
    name: input.name.trim(),
    displayName: input.displayName.trim(),
    status: input.status ?? "ACTIVE",
    isDefault: input.isDefault ?? false,
  };
}

export function normalizeUpdateBrandInput(
  input: UpdateBrandInput
): UpdateBrandInput {
  return {
    ...(input.code !== undefined ? { code: normalizeBrandCode(input.code) } : {}),
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.displayName !== undefined
      ? { displayName: input.displayName.trim() }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
  };
}
