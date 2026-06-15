import {
  createBrand,
  setDefaultBrand,
  updateBrand,
} from "../src/domains/brands/brand.service";
import { findBrandByCode } from "../src/domains/brands/brand.repository";

const DEFAULT_BRAND = {
  code: "MAIN",
  name: "Main Brand",
  displayName: "Main Brand",
  status: "ACTIVE" as const,
  isDefault: true,
};

async function main() {
  const existingBrand = await findBrandByCode(DEFAULT_BRAND.code);
  const brand = existingBrand
    ? await updateBrand(existingBrand.id, DEFAULT_BRAND)
    : await createBrand(DEFAULT_BRAND);
  const defaultBrand = await setDefaultBrand(brand.id);

  console.log("Default brand seeded successfully.");
  console.log(`Code: ${defaultBrand.code}`);
  console.log(`Name: ${defaultBrand.name}`);
}

main().catch((error: unknown) => {
  console.error("Supabase brand seed error:", error);
  console.error(
    error instanceof Error ? error.message : "Default brand seed failed."
  );
  process.exit(1);
});
