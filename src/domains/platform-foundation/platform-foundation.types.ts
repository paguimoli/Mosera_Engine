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

export const websiteDomainStatuses = ["PendingVerification", "Active", "Suspended", "Retired"] as const;

export type WebsiteDomainStatus = (typeof websiteDomainStatuses)[number];

export interface WebsiteDefinition {
  readonly id: string;
  readonly tenantId: string;
  readonly brandId: string;
  readonly marketId?: string;
  readonly websiteCode: string;
  readonly displayName: string;
  readonly status: PlatformLifecycleState;
  readonly defaultLanguage: string;
  readonly defaultCurrency: string;
  readonly defaultTimezone: string;
  readonly maintenanceMode: boolean;
  readonly futureThemeReference?: Record<string, unknown>;
  readonly futureHomepageConfig?: Record<string, unknown>;
  readonly version: string;
  readonly contentHash: string;
  readonly auditMetadata: PlatformAuditMetadata;
}

export interface WebsiteDomainDefinition {
  readonly id: string;
  readonly websiteId: string;
  readonly hostname: string;
  readonly canonical: boolean;
  readonly status: WebsiteDomainStatus;
  readonly verificationStatus: string;
  readonly tlsMode?: Record<string, unknown>;
  readonly cloudflareProxyMetadata?: Record<string, unknown>;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly version: string;
  readonly contentHash: string;
  readonly auditMetadata: PlatformAuditMetadata;
}

export interface HostResolutionDefinition {
  readonly hostname: string;
  readonly tenantId: string;
  readonly brandId: string;
  readonly marketId?: string;
  readonly websiteId: string;
  readonly canonicalRedirectTarget?: string;
  readonly maintenanceMode: boolean;
  readonly activeOnly: true;
}

export const brandAssetTypes = ["LOGO", "FAVICON", "APP_ICON", "EMAIL_HEADER", "BACKGROUND", "PROMOTIONAL"] as const;

export type BrandAssetType = (typeof brandAssetTypes)[number];

export interface BrandThemeDefinition {
  readonly id: string;
  readonly tenantId: string;
  readonly brandId: string;
  readonly themeCode: string;
  readonly displayName: string;
  readonly status: PlatformLifecycleState;
  readonly isDefault: boolean;
  readonly colorTokens: Record<string, unknown>;
  readonly typographyTokens: Record<string, unknown>;
  readonly spacingRadiusTokens: Record<string, unknown>;
  readonly componentTokenPlaceholders: Record<string, unknown>;
  readonly modeSupport: readonly ("light" | "dark")[];
  readonly version: string;
  readonly contentHash: string;
  readonly auditMetadata: PlatformAuditMetadata;
}

export interface BrandAssetDefinition {
  readonly id: string;
  readonly tenantId: string;
  readonly brandId: string;
  readonly assetType: BrandAssetType;
  readonly assetKey: string;
  readonly storageReferencePlaceholder: Record<string, unknown>;
  readonly mimeType: string;
  readonly assetChecksumHash: string;
  readonly status: PlatformLifecycleState;
  readonly version: string;
  readonly contentHash: string;
  readonly auditMetadata: PlatformAuditMetadata;
}

export interface GameAvailabilityDefinition {
  readonly id: string;
  readonly tenantId: string;
  readonly brandId: string;
  readonly marketId?: string;
  readonly websiteId?: string;
  readonly agentId?: string;
  readonly gameId: string;
  readonly gameCode: string;
  readonly gameManifestReference?: string;
  readonly jurisdiction?: string;
  readonly status: PlatformLifecycleState;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly minWagerOverride?: number;
  readonly maxWagerOverride?: number;
  readonly languageOverride?: string;
  readonly currencyOverride?: string;
  readonly timezoneOverride?: string;
  readonly version: string;
  readonly contentHash: string;
  readonly auditMetadata: PlatformAuditMetadata;
}

export interface GameAvailabilityResolution {
  readonly availabilityId: string;
  readonly tenantId: string;
  readonly brandId: string;
  readonly marketId?: string;
  readonly websiteId?: string;
  readonly agentId?: string;
  readonly gameId: string;
  readonly gameCode: string;
  readonly gameManifestReference?: string;
  readonly status: PlatformLifecycleState;
  readonly isAvailable: boolean;
  readonly specificityRank: number;
  readonly minWagerOverride?: number;
  readonly maxWagerOverride?: number;
  readonly languageOverride?: string;
  readonly currencyOverride?: string;
  readonly timezoneOverride?: string;
  readonly contentHash: string;
}

export interface PlatformHierarchyDefinition {
  readonly organization: OrganizationDefinition;
  readonly tenants: readonly TenantDefinition[];
  readonly brands: readonly BrandDefinition[];
  readonly markets: readonly MarketDefinition[];
  readonly websites?: readonly WebsiteDefinition[];
  readonly domains?: readonly WebsiteDomainDefinition[];
  readonly themes?: readonly BrandThemeDefinition[];
  readonly assets?: readonly BrandAssetDefinition[];
  readonly gameAvailability?: readonly GameAvailabilityDefinition[];
}
