import type { Brand } from "./brand.types";
import { listBrands as listBrandRecords } from "./brand.repository";

export async function listBrands(): Promise<Brand[]> {
  return listBrandRecords();
}
