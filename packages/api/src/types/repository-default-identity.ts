import { z } from "zod";

import { normalizeRepoFullName } from "./branch-repository.ts";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "./github-read-model.ts";
import { VcsProviderKind } from "./vcs-provider-kind.ts";

/** Whether repository-default evidence is current, retained-but-stale, or absent. */
export const RepositoryDefaultAvailability = {
  Available: "available",
  Stale: "stale",
  Unavailable: "unavailable",
} as const;
export type RepositoryDefaultAvailability =
  (typeof RepositoryDefaultAvailability)[keyof typeof RepositoryDefaultAvailability];

/** Completeness of one bounded repository-default observation. */
export const RepositoryDefaultCompleteness = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
} as const;
export type RepositoryDefaultCompleteness =
  (typeof RepositoryDefaultCompleteness)[keyof typeof RepositoryDefaultCompleteness];

/** Why a repository-default observation is not current and complete. */
export const RepositoryDefaultReason = {
  NotReported: "not_reported",
  Malformed: "malformed",
  Conflicting: "conflicting",
  Ambiguous: "ambiguous",
  PermissionDenied: "permission_denied",
  PermissionFiltered: "permission_filtered",
  RateLimited: "rate_limited",
  ProviderError: "provider_error",
  Capped: "capped",
  /** Compatibility-only classification for historical all-null persistence groups. */
  LegacyRecord: "legacy_record",
  /** Compatibility-only fallback for members introduced by a newer peer. */
  Unknown: "unknown",
} as const;
export type RepositoryDefaultReason =
  (typeof RepositoryDefaultReason)[keyof typeof RepositoryDefaultReason];

/** Exact provider lane that observed repository-default evidence. */
export const RepositoryDefaultSource = {
  RepositoryRest: "repository_rest",
  InstallationRepositoriesRest: "installation_repositories_rest",
  PullRequestRest: "pull_request_rest",
  RepositoryGraphql: "repository_graphql",
  PullRequestGraphql: "pull_request_graphql",
  InstallationWebhook: "installation_webhook",
  PushWebhook: "push_webhook",
  PullRequestWebhook: "pull_request_webhook",
  /** Compatibility-only fallback for source members introduced by a newer peer. */
  Unknown: "unknown",
} as const;
export type RepositoryDefaultSource =
  (typeof RepositoryDefaultSource)[keyof typeof RepositoryDefaultSource];

const REPOSITORY_FULL_NAME_RE = /^[^/\s]+\/[^/\s]+$/;
const COMPATIBILITY_REASONS = new Set<RepositoryDefaultReason>([
  RepositoryDefaultReason.LegacyRecord,
  RepositoryDefaultReason.Unknown,
]);

/** Provider-qualified repository identity; short repository names are invalid. */
export const repositoryDefaultIdentityValidator = z
  .object({
    provider: z.enum(VcsProviderKind),
    providerRepositoryId: z.string().trim().min(1),
    fullName: z
      .string()
      .transform(normalizeRepoFullName)
      .refine((value) => REPOSITORY_FULL_NAME_RE.test(value), {
        message: "repository fullName must be canonical owner/name",
      }),
  })
  .strict();
export type RepositoryDefaultIdentity = z.infer<
  typeof repositoryDefaultIdentityValidator
>;

export const repositoryDefaultProvenanceValidator = z
  .object({
    source: z.enum(RepositoryDefaultSource),
    /** Raw future source retained only when `source` classifies as unknown. */
    sourceIdentity: z.string().trim().min(1).optional(),
    mechanism: z.enum(GitHubFetchMechanism),
    trigger: z.enum(GitHubFetchTrigger),
    credentialType: z.enum(GitHubFetchCredentialType),
    credentialOwnerId: z.uuid().optional(),
    observationKey: z.string().trim().min(1),
    observedAt: z.iso.datetime(),
    eventAt: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((provenance, context) => {
    if (
      provenance.sourceIdentity !== undefined &&
      provenance.source !== RepositoryDefaultSource.Unknown
    ) {
      context.addIssue({
        code: "custom",
        message: "sourceIdentity is reserved for unknown compatibility sources",
        path: ["sourceIdentity"],
      });
    }
  });
export type RepositoryDefaultProvenance = z.infer<
  typeof repositoryDefaultProvenanceValidator
>;

/** Provenance-preserving typed absence for an inaccessible repository identity. */
export const repositoryDefaultUnavailableObservationValidator = z
  .object({
    reason: z.enum(RepositoryDefaultReason),
    provenance: repositoryDefaultProvenanceValidator,
  })
  .strict()
  .superRefine((observation, context) => {
    if (COMPATIBILITY_REASONS.has(observation.reason)) {
      context.addIssue({
        code: "custom",
        message: "producer evidence reason must not be compatibility-only",
        path: ["reason"],
      });
    }
    if (observation.provenance.source === RepositoryDefaultSource.Unknown) {
      context.addIssue({
        code: "custom",
        message: "producer provenance source must be known",
        path: ["provenance", "source"],
      });
    }
    if (
      observation.provenance.mechanism === GitHubFetchMechanism.Unknown ||
      observation.provenance.trigger === GitHubFetchTrigger.Unknown ||
      observation.provenance.credentialType ===
        GitHubFetchCredentialType.Unknown
    ) {
      context.addIssue({
        code: "custom",
        message: "producer provenance classifications must be known",
        path: ["provenance"],
      });
    }
  });
export type RepositoryDefaultUnavailableObservation = z.infer<
  typeof repositoryDefaultUnavailableObservationValidator
>;

const availableRepositoryDefaultEvidenceValidator = z
  .object({
    availability: z.literal(RepositoryDefaultAvailability.Available),
    completeness: z.literal(RepositoryDefaultCompleteness.Complete),
    defaultBranch: z.string().trim().min(1),
  })
  .strict();

const staleRepositoryDefaultEvidenceValidator = z
  .object({
    availability: z.literal(RepositoryDefaultAvailability.Stale),
    completeness: z.literal(RepositoryDefaultCompleteness.Partial),
    defaultBranch: z.string().trim().min(1),
    reason: z.enum(RepositoryDefaultReason),
  })
  .strict();

const unavailableRepositoryDefaultEvidenceValidator = z
  .object({
    availability: z.literal(RepositoryDefaultAvailability.Unavailable),
    completeness: z.union([
      z.literal(RepositoryDefaultCompleteness.Partial),
      z.literal(RepositoryDefaultCompleteness.Unavailable),
    ]),
    reason: z.enum(RepositoryDefaultReason),
  })
  .strict();

/** Discriminated evidence prevents unavailable observations from carrying a branch. */
export const repositoryDefaultEvidenceValidator = z.discriminatedUnion(
  "availability",
  [
    availableRepositoryDefaultEvidenceValidator,
    staleRepositoryDefaultEvidenceValidator,
    unavailableRepositoryDefaultEvidenceValidator,
  ]
);
export type RepositoryDefaultEvidence = z.infer<
  typeof repositoryDefaultEvidenceValidator
>;

const repositoryDefaultAuthoritySchema = z
  .object({
    repository: repositoryDefaultIdentityValidator,
    evidence: repositoryDefaultEvidenceValidator,
    provenance: repositoryDefaultProvenanceValidator,
  })
  .strict();

/** Canonical additive repository-default authority group shared across producers. */
export type RepositoryDefaultAuthority = z.infer<
  typeof repositoryDefaultAuthoritySchema
>;

/**
 * Strict producer boundary. Compatibility-only enum members are accepted only
 * by the normalizer used for historical or version-skewed input.
 */
export const repositoryDefaultAuthorityValidator =
  repositoryDefaultAuthoritySchema.superRefine((authority, context) => {
    if (authority.provenance.source === RepositoryDefaultSource.Unknown) {
      context.addIssue({
        code: "custom",
        message: "producer provenance source must be known",
        path: ["provenance", "source"],
      });
    }
    if (
      authority.provenance.mechanism === GitHubFetchMechanism.Unknown ||
      authority.provenance.trigger === GitHubFetchTrigger.Unknown ||
      authority.provenance.credentialType === GitHubFetchCredentialType.Unknown
    ) {
      context.addIssue({
        code: "custom",
        message: "producer provenance classifications must be known",
        path: ["provenance"],
      });
    }
    if (
      "reason" in authority.evidence &&
      COMPATIBILITY_REASONS.has(authority.evidence.reason)
    ) {
      context.addIssue({
        code: "custom",
        message: "producer evidence reason must not be compatibility-only",
        path: ["evidence", "reason"],
      });
    }
    if (
      "reason" in authority.evidence &&
      authority.evidence.reason === RepositoryDefaultReason.Capped &&
      authority.evidence.completeness !== RepositoryDefaultCompleteness.Partial
    ) {
      context.addIssue({
        code: "custom",
        message: "capped evidence must be partial",
        path: ["evidence", "completeness"],
      });
    }
  });

const compatibilityAuthorityValidator = z.object({
  repository: repositoryDefaultIdentityValidator,
  provenance: z.object({
    source: z.unknown(),
    sourceIdentity: z.unknown().optional(),
    mechanism: z.unknown(),
    trigger: z.unknown(),
    credentialType: z.unknown(),
    credentialOwnerId: z.uuid().optional(),
    observationKey: z.string().trim().min(1),
    observedAt: z.iso.datetime(),
    eventAt: z.iso.datetime().optional(),
  }),
});

/**
 * Preserve legacy omission and normalize present newer-peer members
 * conservatively. Unknown evidence never becomes a plausible default branch.
 */
export function normalizeRepositoryDefaultAuthority(
  value: unknown
): RepositoryDefaultAuthority | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const known = repositoryDefaultAuthorityValidator.safeParse(value);
  if (known.success) {
    return known.data;
  }

  const compatible = compatibilityAuthorityValidator.safeParse(value);
  if (!compatible.success) {
    return undefined;
  }

  const { repository, provenance } = compatible.data;
  const source = normalizeConstValue(
    provenance.source,
    RepositoryDefaultSource
  );
  const sourceIdentity = compatibilitySourceIdentity(
    provenance.source,
    provenance.sourceIdentity,
    source
  );
  return {
    repository,
    evidence: {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.Unknown,
    },
    provenance: {
      source,
      ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
      mechanism: normalizeConstValue(
        provenance.mechanism,
        GitHubFetchMechanism
      ),
      trigger: normalizeConstValue(provenance.trigger, GitHubFetchTrigger),
      credentialType: normalizeConstValue(
        provenance.credentialType,
        GitHubFetchCredentialType
      ),
      observationKey: provenance.observationKey,
      observedAt: provenance.observedAt,
      ...(provenance.credentialOwnerId === undefined
        ? {}
        : { credentialOwnerId: provenance.credentialOwnerId }),
      ...(provenance.eventAt === undefined
        ? {}
        : { eventAt: provenance.eventAt }),
    },
  };
}

/** Nullable persistence columns for one additive repository-default group. */
export type PersistedRepositoryDefaultAuthorityColumns = {
  defaultBranchName?: unknown;
  defaultBranchAvailability?: unknown;
  defaultBranchCompleteness?: unknown;
  defaultBranchReason?: unknown;
  defaultBranchSource?: unknown;
  defaultBranchMechanism?: unknown;
  defaultBranchTrigger?: unknown;
  defaultBranchCredentialType?: unknown;
  defaultBranchCredentialOwnerId?: unknown;
  defaultBranchObservationKey?: unknown;
  defaultBranchObservedAt?: unknown;
  defaultBranchEventAt?: unknown;
};

/**
 * Read-side authority shape. Legacy or corrupt persisted groups may lack enough
 * provenance to construct a producer authority, so provenance remains omitted.
 */
export type NormalizedPersistedRepositoryDefaultAuthority = {
  repository: RepositoryDefaultIdentity;
  evidence: RepositoryDefaultEvidence;
  provenance?: RepositoryDefaultProvenance;
};

/**
 * Normalize nullable database columns without rewriting them. All-null legacy
 * groups remain explicitly legacy; present unknown/corrupt groups become
 * unavailable/unknown and can never supply a plausible default branch.
 */
export function normalizePersistedRepositoryDefaultAuthority(
  repository: unknown,
  columns: PersistedRepositoryDefaultAuthorityColumns
): NormalizedPersistedRepositoryDefaultAuthority | undefined {
  const parsedRepository =
    repositoryDefaultIdentityValidator.safeParse(repository);
  if (!parsedRepository.success) {
    return undefined;
  }
  if (persistedColumnsAreEmpty(columns)) {
    return persistedUnavailableAuthority(
      parsedRepository.data,
      RepositoryDefaultReason.LegacyRecord
    );
  }

  const provenance = persistedProvenance(columns);
  if (provenance === undefined) {
    return persistedUnavailableAuthority(
      parsedRepository.data,
      RepositoryDefaultReason.Unknown
    );
  }

  const normalized = normalizeRepositoryDefaultAuthority({
    repository: parsedRepository.data,
    evidence: persistedEvidence(columns),
    provenance,
  });
  return (
    normalized ??
    persistedUnavailableAuthority(
      parsedRepository.data,
      RepositoryDefaultReason.Unknown
    )
  );
}

function persistedColumnsAreEmpty(
  columns: PersistedRepositoryDefaultAuthorityColumns
): boolean {
  return [
    columns.defaultBranchName,
    columns.defaultBranchAvailability,
    columns.defaultBranchCompleteness,
    columns.defaultBranchReason,
    columns.defaultBranchSource,
    columns.defaultBranchMechanism,
    columns.defaultBranchTrigger,
    columns.defaultBranchCredentialType,
    columns.defaultBranchCredentialOwnerId,
    columns.defaultBranchObservationKey,
    columns.defaultBranchObservedAt,
    columns.defaultBranchEventAt,
  ].every((value) => value === null || value === undefined);
}

function persistedEvidence(
  columns: PersistedRepositoryDefaultAuthorityColumns
) {
  return {
    availability: columns.defaultBranchAvailability,
    completeness: columns.defaultBranchCompleteness,
    ...(columns.defaultBranchName === null ||
    columns.defaultBranchName === undefined
      ? {}
      : { defaultBranch: columns.defaultBranchName }),
    ...(columns.defaultBranchReason === null ||
    columns.defaultBranchReason === undefined
      ? {}
      : { reason: columns.defaultBranchReason }),
  };
}

function persistedProvenance(
  columns: PersistedRepositoryDefaultAuthorityColumns
): Record<string, unknown> | undefined {
  const observedAt = normalizePersistedInstant(columns.defaultBranchObservedAt);
  if (
    columns.defaultBranchSource === null ||
    columns.defaultBranchSource === undefined ||
    columns.defaultBranchMechanism === null ||
    columns.defaultBranchMechanism === undefined ||
    columns.defaultBranchTrigger === null ||
    columns.defaultBranchTrigger === undefined ||
    columns.defaultBranchCredentialType === null ||
    columns.defaultBranchCredentialType === undefined ||
    typeof columns.defaultBranchObservationKey !== "string" ||
    observedAt === undefined
  ) {
    return undefined;
  }

  const eventAt = normalizePersistedInstant(columns.defaultBranchEventAt);
  return {
    source: columns.defaultBranchSource,
    mechanism: columns.defaultBranchMechanism,
    trigger: columns.defaultBranchTrigger,
    credentialType: columns.defaultBranchCredentialType,
    observationKey: columns.defaultBranchObservationKey,
    observedAt,
    ...(columns.defaultBranchCredentialOwnerId === null ||
    columns.defaultBranchCredentialOwnerId === undefined
      ? {}
      : { credentialOwnerId: columns.defaultBranchCredentialOwnerId }),
    ...(eventAt === undefined ? {} : { eventAt }),
  };
}

function normalizePersistedInstant(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return typeof value === "string" ? value : undefined;
}

function persistedUnavailableAuthority(
  repository: RepositoryDefaultIdentity,
  reason:
    | typeof RepositoryDefaultReason.LegacyRecord
    | typeof RepositoryDefaultReason.Unknown
): NormalizedPersistedRepositoryDefaultAuthority {
  return {
    repository,
    evidence: {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason,
    },
  };
}

function normalizeConstValue<Value extends string>(
  value: unknown,
  values: Record<string, Value> & { Unknown: Value }
): Value {
  const knownValues = Object.values(values) as Value[];
  const matchedValue =
    typeof value === "string"
      ? knownValues.find((knownValue) => knownValue === value)
      : undefined;
  return matchedValue ?? values.Unknown;
}

function compatibilitySourceIdentity(
  rawSource: unknown,
  existingIdentity: unknown,
  normalizedSource: RepositoryDefaultSource
): string | undefined {
  if (normalizedSource !== RepositoryDefaultSource.Unknown) {
    return undefined;
  }
  if (typeof rawSource === "string") {
    const trimmedSource = rawSource.trim();
    if (
      trimmedSource.length > 0 &&
      trimmedSource !== RepositoryDefaultSource.Unknown
    ) {
      return trimmedSource;
    }
  }
  if (typeof existingIdentity !== "string") {
    return undefined;
  }
  const trimmedIdentity = existingIdentity.trim();
  return trimmedIdentity.length > 0 ? trimmedIdentity : undefined;
}
