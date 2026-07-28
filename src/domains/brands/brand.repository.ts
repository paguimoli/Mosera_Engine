import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  Brand,
  BrandStatus,
} from "./brand.types";
import { normalizeBrandCode } from "./brand.validation";

type BrandRow = {
  id: string;
  code: string;
  name: string;
  display_name: string;
  status: BrandStatus;
  is_default: boolean;
  created_at: string;
  updated_at?: string | null;
};

export class BrandRepositoryError extends Error {
  constructor(message = "Brand persistence operation failed.") {
    super(message);
    this.name = "BrandRepositoryError";
  }
}

const BRAND_SELECT =
  "id, code, name, display_name, status, is_default, created_at, updated_at";

function mapBrandRow(row: BrandRow | null): Brand | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    displayName: row.display_name,
    status: row.status,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

export async function findBrandById(id: string): Promise<Brand | null> {
  const { data, error } = await supabaseServerAdmin
    .from("brands")
    .select(BRAND_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new BrandRepositoryError();
  }

  return mapBrandRow(data as BrandRow | null);
}

export async function findBrandByCode(code: string): Promise<Brand | null> {
  const { data, error } = await supabaseServerAdmin
    .from("brands")
    .select(BRAND_SELECT)
    .eq("code", normalizeBrandCode(code))
    .maybeSingle();

  if (error) {
    throw new BrandRepositoryError();
  }

  return mapBrandRow(data as BrandRow | null);
}

export async function listBrands(): Promise<Brand[]> {
  const { data, error } = await supabaseServerAdmin
    .from("brands")
    .select(BRAND_SELECT)
    .order("is_default", { ascending: false })
    .order("code", { ascending: true });

  if (error) {
    throw new BrandRepositoryError();
  }

  return ((data ?? []) as BrandRow[])
    .map(mapBrandRow)
    .filter((brand): brand is Brand => Boolean(brand));
}

export async function getDefaultBrand(): Promise<Brand | null> {
  const { data, error } = await supabaseServerAdmin
    .from("brands")
    .select(BRAND_SELECT)
    .eq("is_default", true)
    .maybeSingle();

  if (error) {
    throw new BrandRepositoryError();
  }

  return mapBrandRow(data as BrandRow | null);
}
