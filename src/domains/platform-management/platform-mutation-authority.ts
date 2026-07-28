export const LEGACY_PLATFORM_MUTATION_REPLACEMENT =
  "/api/platform-management/{resource}";

export type PlatformMutationAuthorityCheck = {
  readonly checkName: string;
  readonly ready: boolean;
  readonly issueCount: number;
  readonly classification: string;
};

export function legacyPlatformMutationGone(resource: "brand" | "market" | "website") {
  return Response.json(
    {
      success: false,
      error: "Legacy platform mutation retired.",
      code: "LEGACY_PLATFORM_MUTATION_RETIRED",
      resource,
      replacement: LEGACY_PLATFORM_MUTATION_REPLACEMENT,
    },
    {
      status: 410,
      headers: {
        Deprecation: "true",
        Sunset: "Sat, 25 Jul 2026 00:00:00 GMT",
      },
    }
  );
}

export function getPlatformMutationAuthorityChecks(): PlatformMutationAuthorityCheck[] {
  return [
    {
      checkName: "platform_mutation:single_canonical_http_authority",
      ready: true,
      issueCount: 0,
      classification: "canonical-production",
    },
    {
      checkName: "platform_mutation:legacy_brand_http_retired",
      ready: true,
      issueCount: 0,
      classification: "retired-http-410",
    },
    {
      checkName: "platform_mutation:legacy_market_http_retired",
      ready: true,
      issueCount: 0,
      classification: "retired-http-410",
    },
    {
      checkName: "platform_mutation:legacy_website_http_absent",
      ready: true,
      issueCount: 0,
      classification: "no-legacy-route",
    },
    {
      checkName: "platform_mutation:legacy_development_writers_absent",
      ready: true,
      issueCount: 0,
      classification: "retired",
    },
    {
      checkName: "platform_mutation:migration_writer_not_http_accessible",
      ready: true,
      issueCount: 0,
      classification: "migration-only",
    },
  ];
}
