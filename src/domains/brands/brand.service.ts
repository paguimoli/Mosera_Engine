import type { Brand, CreateBrandInput, UpdateBrandInput } from "./brand.types";
import {
  createBrand as createBrandRecord,
  disableBrand as disableBrandRecord,
  findBrandByCode,
  findBrandById,
  listBrands as listBrandRecords,
  setDefaultBrand as setDefaultBrandRecord,
  updateBrand as updateBrandRecord,
} from "./brand.repository";
import {
  normalizeCreateBrandInput,
  normalizeUpdateBrandInput,
  validateCreateBrandInput,
  validateUpdateBrandInput,
} from "./brand.validation";

export class DuplicateBrandCodeError extends Error {
  constructor(message = "Duplicate brand code.") {
    super(message);
    this.name = "DuplicateBrandCodeError";
  }
}

export class BrandValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "BrandValidationError";
    this.errors = errors;
  }
}

export class BrandBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandBusinessRuleError";
  }
}

export async function createBrand(input: CreateBrandInput): Promise<Brand> {
  const validation = validateCreateBrandInput(input);

  if (!validation.valid) {
    throw new BrandValidationError(validation.errors);
  }

  const normalized = normalizeCreateBrandInput(input);
  const existingBrand = await findBrandByCode(normalized.code);

  if (existingBrand) {
    throw new DuplicateBrandCodeError();
  }

  const brand = await createBrandRecord(normalized);

  if (normalized.isDefault) {
    return setDefaultBrandRecord(brand.id);
  }

  return brand;
}

export async function updateBrand(
  id: string,
  input: UpdateBrandInput
): Promise<Brand> {
  const validation = validateUpdateBrandInput(input);

  if (!validation.valid) {
    throw new BrandValidationError(validation.errors);
  }

  const normalized = normalizeUpdateBrandInput(input);

  if (normalized.code) {
    const existingBrand = await findBrandByCode(normalized.code);

    if (existingBrand && existingBrand.id !== id) {
      throw new DuplicateBrandCodeError();
    }
  }

  const brand = await updateBrandRecord(id, normalized);

  if (normalized.isDefault) {
    return setDefaultBrandRecord(brand.id);
  }

  return brand;
}

export async function setDefaultBrand(id: string): Promise<Brand> {
  const brand = await findBrandById(id);

  if (!brand) {
    throw new BrandBusinessRuleError("Brand not found.");
  }

  return setDefaultBrandRecord(id);
}

export async function disableBrand(id: string): Promise<Brand> {
  const brand = await findBrandById(id);

  if (!brand) {
    throw new BrandBusinessRuleError("Brand not found.");
  }

  if (brand.isDefault) {
    throw new BrandBusinessRuleError("Cannot disable the default brand.");
  }

  return disableBrandRecord(id);
}

export async function listBrands(): Promise<Brand[]> {
  return listBrandRecords();
}
