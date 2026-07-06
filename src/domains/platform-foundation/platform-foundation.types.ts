export const platformLifecycleStates = ["Draft", "Active", "Suspended", "Retired"] as const;

export type PlatformLifecycleState = (typeof platformLifecycleStates)[number];

export interface PlatformAuditMetadata {
  readonly createdBy?: string;
  readonly reason?: string;
  readonly source?: string;
  readonly correlationId?: string;
}

export interface VersionedPlatformRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: PlatformLifecycleState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: string;
  readonly contentHash: string;
  readonly auditMetadata: PlatformAuditMetadata;
}

export interface OrganizationDefinition extends VersionedPlatformRecord {
  readonly governanceMetadata: Record<string, unknown>;
  readonly globalDefaults: Record<string, unknown>;
}

export interface TenantDefinition extends VersionedPlatformRecord {
  readonly organizationId: string;
  readonly operatorMetadata: Record<string, unknown>;
  readonly defaultLanguage: string;
  readonly defaultCurrency: string;
  readonly defaultTimezone: string;
  readonly creditEnabled: boolean;
  readonly cashierEnabled: boolean;
}

export interface BrandDefinition extends VersionedPlatformRecord {
  readonly tenantId: string;
  readonly displayName: string;
  readonly futureThemeReference?: Record<string, unknown>;
  readonly futureAssetReference?: Record<string, unknown>;
  readonly futureWebsiteReferences?: readonly string[];
}

export interface MarketDefinition extends VersionedPlatformRecord {
  readonly brandId: string;
  readonly displayName: string;
  readonly country?: string;
  readonly jurisdiction?: string;
  readonly language: string;
  readonly currency: string;
  readonly timezone: string;
  readonly futureGameAvailability?: Record<string, unknown>;
}

export interface PlatformHierarchyDefinition {
  readonly organization: OrganizationDefinition;
  readonly tenants: readonly TenantDefinition[];
  readonly brands: readonly BrandDefinition[];
  readonly markets: readonly MarketDefinition[];
}
