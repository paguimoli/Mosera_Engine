export type BrandStatus = "ACTIVE" | "DISABLED";

export type Brand = {
  id: string;
  code: string;
  name: string;
  displayName: string;
  status: BrandStatus;
  isDefault: boolean;
  createdAt: string;
  updatedAt?: string | null;
};

export type CreateBrandInput = {
  code: string;
  name: string;
  displayName: string;
  status?: BrandStatus;
  isDefault?: boolean;
};

export type UpdateBrandInput = Partial<CreateBrandInput>;
