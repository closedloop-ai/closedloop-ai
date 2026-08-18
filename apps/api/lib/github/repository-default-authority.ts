import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  type RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { log } from "@repo/observability/log";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";

/** Inputs shared by bounded REST and webhook repository authority producers. */
export type GitHubRepositoryDefaultAuthorityInput = {
  providerRepositoryId: string;
  fullName: string;
  defaultBranch: unknown;
  source: RepositoryDefaultSource;
  mechanism: GitHubFetchMechanism;
  trigger: GitHubFetchTrigger;
  credentialType: GitHubFetchCredentialType;
  credentialOwnerId?: string;
  observationKey: string;
  observedAt: Date;
  eventAt?: Date;
};

/**
 * Validate one GitHub repository payload into the canonical authority group.
 * Missing defaults remain typed unavailable; malformed values are monitored
 * and never persisted as plausible branch names.
 */
export function mapGitHubRepositoryDefaultAuthority(
  input: GitHubRepositoryDefaultAuthorityInput
): RepositoryDefaultAuthority | undefined {
  const normalizedDefaultBranch = normalizeDefaultBranch(input.defaultBranch);
  const evidence = normalizedDefaultBranch.evidence;
  const candidate = {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: input.providerRepositoryId,
      fullName: input.fullName,
    },
    evidence,
    provenance: {
      source: input.source,
      mechanism: input.mechanism,
      trigger: input.trigger,
      credentialType: input.credentialType,
      ...(input.credentialOwnerId
        ? { credentialOwnerId: input.credentialOwnerId }
        : {}),
      observationKey: input.observationKey,
      observedAt: input.observedAt.toISOString(),
      ...(input.eventAt ? { eventAt: input.eventAt.toISOString() } : {}),
    },
  };
  const parsed = repositoryDefaultAuthorityValidator.safeParse(candidate);
  if (!parsed.success) {
    emitMalformedAuthority(input, "invalid_identity_or_provenance");
    return undefined;
  }
  if (normalizedDefaultBranch.malformed) {
    emitMalformedAuthority(input, "malformed_default_branch");
  }
  return parsed.data;
}

/** Map repository-bearing webhook payloads with delivery-scoped idempotency. */
export function mapGitHubWebhookRepositoryDefaultAuthority(
  repository: {
    id: number;
    full_name: string;
    default_branch?: unknown;
  },
  source: RepositoryDefaultSource,
  context: GitHubWebhookObservationContext | undefined,
  eventAt?: Date
): RepositoryDefaultAuthority | undefined {
  if (!context) {
    emitMalformedWebhookEnvelope(repository, source);
    return undefined;
  }
  return mapGitHubRepositoryDefaultAuthority({
    providerRepositoryId: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    source,
    mechanism: GitHubFetchMechanism.Webhook,
    trigger: GitHubFetchTrigger.Webhook,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey: context.deliveryId,
    observedAt: context.observedAt,
    ...(eventAt ? { eventAt } : {}),
  });
}

/** Flatten validated authority into the shared cloud repository columns. */
export function repositoryDefaultAuthorityPersistenceData(
  authority: RepositoryDefaultAuthority
): RepositoryDefaultAuthorityPersistenceData;
export function repositoryDefaultAuthorityPersistenceData(
  authority: undefined
): Record<string, never>;
export function repositoryDefaultAuthorityPersistenceData(
  authority: RepositoryDefaultAuthority | undefined
): RepositoryDefaultAuthorityPersistenceData | Record<string, never>;
export function repositoryDefaultAuthorityPersistenceData(
  authority: RepositoryDefaultAuthority | undefined
): RepositoryDefaultAuthorityPersistenceData | Record<string, never> {
  if (!authority) {
    return {};
  }
  return {
    defaultBranchName:
      "defaultBranch" in authority.evidence
        ? authority.evidence.defaultBranch
        : null,
    defaultBranchAvailability: authority.evidence.availability,
    defaultBranchCompleteness: authority.evidence.completeness,
    defaultBranchReason:
      "reason" in authority.evidence ? authority.evidence.reason : null,
    defaultBranchSource: authority.provenance.source,
    defaultBranchMechanism: authority.provenance.mechanism,
    defaultBranchTrigger: authority.provenance.trigger,
    defaultBranchCredentialType: authority.provenance.credentialType,
    defaultBranchCredentialOwnerId:
      authority.provenance.credentialOwnerId ?? null,
    defaultBranchObservationKey: authority.provenance.observationKey,
    defaultBranchObservedAt: new Date(authority.provenance.observedAt),
    defaultBranchEventAt: authority.provenance.eventAt
      ? new Date(authority.provenance.eventAt)
      : null,
  };
}

export type RepositoryDefaultAuthorityPersistenceData = {
  defaultBranchName: string | null;
  defaultBranchAvailability: RepositoryDefaultAuthority["evidence"]["availability"];
  defaultBranchCompleteness: RepositoryDefaultAuthority["evidence"]["completeness"];
  defaultBranchReason: RepositoryDefaultReason | null;
  defaultBranchSource: RepositoryDefaultAuthority["provenance"]["source"];
  defaultBranchMechanism: RepositoryDefaultAuthority["provenance"]["mechanism"];
  defaultBranchTrigger: RepositoryDefaultAuthority["provenance"]["trigger"];
  defaultBranchCredentialType: RepositoryDefaultAuthority["provenance"]["credentialType"];
  defaultBranchCredentialOwnerId: string | null;
  defaultBranchObservationKey: string;
  defaultBranchObservedAt: Date;
  defaultBranchEventAt: Date | null;
};

function normalizeDefaultBranch(defaultBranch: unknown): {
  evidence: RepositoryDefaultAuthority["evidence"];
  malformed: boolean;
} {
  if (defaultBranch === null || defaultBranch === undefined) {
    return {
      evidence: {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason: RepositoryDefaultReason.NotReported,
      },
      malformed: false,
    };
  }
  if (typeof defaultBranch !== "string" || defaultBranch.trim().length === 0) {
    return {
      evidence: {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason: RepositoryDefaultReason.Malformed,
      },
      malformed: true,
    };
  }
  return {
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: defaultBranch.trim(),
    },
    malformed: false,
  };
}

function emitMalformedAuthority(
  input: GitHubRepositoryDefaultAuthorityInput,
  outcome: string
): void {
  log.error("github_repository_default_authority_malformed", {
    outcome,
    providerRepositoryId: input.providerRepositoryId,
    repositoryFullName: input.fullName,
    source: input.source,
  });
}

function emitMalformedWebhookEnvelope(
  repository: { id: number; full_name: string },
  source: RepositoryDefaultSource
): void {
  log.error("github_repository_default_authority_malformed", {
    outcome: "missing_delivery_id",
    providerRepositoryId: String(repository.id),
    repositoryFullName: repository.full_name,
    source,
  });
}
