import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  normalizePersistedRepositoryDefaultAuthority,
  normalizeRepositoryDefaultAuthority,
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  type RepositoryDefaultEvidence,
  RepositoryDefaultReason,
  repositoryDefaultIdentityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { z } from "zod";
import {
  type StoredRepositoryDefaultAuthority,
  storedRepositoryDefaultAuthoritySchema,
} from "./db-row-types.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** Maximum number of accepted authority observations in one atomic write. */
export const MAX_REPOSITORY_DEFAULT_AUTHORITY_BATCH_SIZE = 100;

const identityKeySchema = z.string().trim().min(1);
const repositoryReadIdentitySchema = repositoryDefaultIdentityValidator.pick({
  provider: true,
  providerRepositoryId: true,
});
const repositoryReadNameSchema = repositoryDefaultIdentityValidator.pick({
  provider: true,
  fullName: true,
});
const storedRepositoryDefaultAuthorityIdentitySchema = z
  .object({
    provider: z.string(),
    providerRepositoryId: z.string(),
    repoFullName: z.string(),
  })
  .passthrough();

export const repositoryDefaultAuthorityReadArgsSchema = z.tuple([
  identityKeySchema,
  z
    .array(repositoryReadIdentitySchema)
    .max(MAX_REPOSITORY_DEFAULT_AUTHORITY_BATCH_SIZE),
]);

export const repositoryDefaultAuthorityReadByRepositoryNamesArgsSchema =
  z.tuple([
    identityKeySchema,
    z
      .array(repositoryReadNameSchema)
      .max(MAX_REPOSITORY_DEFAULT_AUTHORITY_BATCH_SIZE),
  ]);

// Members are constrained only to structured-clone-safe JSON here. Their
// semantic shape is normalized independently so one malformed newer/older peer
// value cannot reject valid siblings or the surrounding hydration response.
export const repositoryDefaultAuthorityWriteArgsSchema = z.tuple([
  identityKeySchema,
  z.array(z.json()),
]);

export type RepositoryDefaultAuthorityReadIdentity = z.infer<
  typeof repositoryReadIdentitySchema
>;
export type RepositoryDefaultAuthorityReadName = z.infer<
  typeof repositoryReadNameSchema
>;

export type RepositoryDefaultAuthorityWriteResult = {
  accepted: number;
  skipped: number;
};

/**
 * Read only the requested provider-qualified repositories for one Desktop
 * account identity. Empty requests avoid an unbounded account-wide query.
 */
export async function readRepositoryDefaultAuthorities(
  prisma: DesktopPrisma,
  identityKey: string,
  repositories: readonly RepositoryDefaultAuthorityReadIdentity[]
): Promise<RepositoryDefaultAuthority[]> {
  const [parsedIdentityKey, parsedRepositories] =
    repositoryDefaultAuthorityReadArgsSchema.parse([identityKey, repositories]);
  const uniqueRepositories = uniqueReadIdentities(parsedRepositories);
  if (uniqueRepositories.length === 0) {
    return [];
  }

  const rows = await prisma.read((reader) =>
    reader.repositoryDefaultAuthority.findMany({
      where: {
        identityKey: parsedIdentityKey,
        OR: uniqueRepositories,
      },
      orderBy: [{ provider: "asc" }, { providerRepositoryId: "asc" }],
    })
  );

  return rows.flatMap((row) => {
    const authority = authorityFromStoredRow(row);
    return authority === undefined ? [] : [authority];
  });
}

/**
 * Read all stable identities matching bounded provider-qualified repository
 * names. Callers must reject zero or multiple identities rather than choosing
 * a plausible repository from a short-name or renamed-repository collision.
 */
export async function readRepositoryDefaultAuthoritiesByNames(
  prisma: DesktopPrisma,
  identityKey: string,
  repositories: readonly RepositoryDefaultAuthorityReadName[]
): Promise<NormalizedPersistedRepositoryDefaultAuthority[]> {
  const [parsedIdentityKey, parsedRepositories] =
    repositoryDefaultAuthorityReadByRepositoryNamesArgsSchema.parse([
      identityKey,
      repositories,
    ]);
  const uniqueRepositories = uniqueReadNames(parsedRepositories);
  if (uniqueRepositories.length === 0) {
    return [];
  }

  const rows = await prisma.read((reader) =>
    reader.repositoryDefaultAuthority.findMany({
      where: {
        identityKey: parsedIdentityKey,
        OR: uniqueRepositories.map((repository) => ({
          provider: repository.provider,
          repoFullName: repository.fullName,
        })),
      },
      orderBy: [{ provider: "asc" }, { providerRepositoryId: "asc" }],
    })
  );

  return rows.flatMap((row) => {
    const authority = persistedAuthorityFromStoredRow(row);
    return authority === undefined ? [] : [authority];
  });
}

/** Normalize nullable/version-skewed persistence without erasing typed absence. */
export function persistedAuthorityFromStoredRow(
  row: unknown
): NormalizedPersistedRepositoryDefaultAuthority | undefined {
  const parsedIdentity =
    storedRepositoryDefaultAuthorityIdentitySchema.safeParse(row);
  if (!parsedIdentity.success) {
    return undefined;
  }
  const columns = parsedIdentity.data;
  return normalizePersistedRepositoryDefaultAuthority(
    {
      provider: parsedIdentity.data.provider,
      providerRepositoryId: parsedIdentity.data.providerRepositoryId,
      fullName: parsedIdentity.data.repoFullName,
    },
    {
      defaultBranchName: columns.defaultBranch,
      defaultBranchAvailability: columns.availability,
      defaultBranchCompleteness: columns.completeness,
      defaultBranchReason: columns.reason,
      defaultBranchSource: columns.source,
      defaultBranchMechanism: columns.mechanism,
      defaultBranchTrigger: columns.trigger,
      defaultBranchCredentialType: columns.credentialType,
      defaultBranchCredentialOwnerId: columns.credentialOwnerId,
      defaultBranchObservationKey: columns.observationKey,
      defaultBranchObservedAt: columns.observedAt,
      defaultBranchEventAt: columns.eventAt,
    }
  );
}

/**
 * Normalize optional observations independently, reject an accepted overflow
 * before persistence, then reconcile the bounded set in one serialized SQLite
 * transaction.
 */
export async function writeRepositoryDefaultAuthorities(
  prisma: DesktopPrisma,
  identityKey: string,
  observations: readonly unknown[]
): Promise<RepositoryDefaultAuthorityWriteResult> {
  const [parsedIdentityKey, parsedObservations] =
    repositoryDefaultAuthorityWriteArgsSchema.parse([
      identityKey,
      observations,
    ]);
  const accepted = parsedObservations.flatMap((observation) => {
    const normalized = normalizeRepositoryDefaultAuthority(observation);
    return normalized === undefined ? [] : [normalized];
  });

  if (accepted.length > MAX_REPOSITORY_DEFAULT_AUTHORITY_BATCH_SIZE) {
    throw new RangeError(
      `repository-default authority batch accepts at most ${MAX_REPOSITORY_DEFAULT_AUTHORITY_BATCH_SIZE} observations`
    );
  }
  if (accepted.length === 0) {
    return { accepted: 0, skipped: parsedObservations.length };
  }

  const updatedAt = new Date().toISOString();
  await prisma.write((client) =>
    client.$transaction(async (transaction) => {
      for (const observation of accepted) {
        await reconcileObservation(
          transaction,
          parsedIdentityKey,
          observation,
          updatedAt
        );
      }
    })
  );

  return {
    accepted: accepted.length,
    skipped: parsedObservations.length - accepted.length,
  };
}

async function reconcileObservation(
  transaction: Prisma.TransactionClient,
  identityKey: string,
  incoming: RepositoryDefaultAuthority,
  updatedAt: string
): Promise<void> {
  const repositoryIdentity = {
    identityKey,
    provider: incoming.repository.provider,
    providerRepositoryId: incoming.repository.providerRepositoryId,
  };
  const current = await transaction.repositoryDefaultAuthority.findUnique({
    where: {
      identityKey_provider_providerRepositoryId: repositoryIdentity,
    },
  });
  if (current === null) {
    await transaction.repositoryDefaultAuthority.create({
      data: storedRowFromAuthority(identityKey, incoming, updatedAt),
      select: REPOSITORY_DEFAULT_AUTHORITY_KEY_SELECT,
    });
    return;
  }

  const currentAuthority = authorityFromStoredRow(current);
  if (currentAuthority === undefined) {
    // A row produced by this create-only table should always parse. If local
    // corruption exists, do not silently normalize or overwrite that evidence.
    throw new Error(
      `stored repository-default authority is malformed for ${current.provider}/${current.providerRepositoryId}`
    );
  }
  const winner = reconcileAuthorities(currentAuthority, incoming);
  if (winner === currentAuthority) {
    return;
  }

  await transaction.repositoryDefaultAuthority.update({
    where: {
      identityKey_provider_providerRepositoryId: repositoryIdentity,
    },
    data: storedMutableFields(winner, updatedAt),
    select: REPOSITORY_DEFAULT_AUTHORITY_KEY_SELECT,
  });
}

function reconcileAuthorities(
  current: RepositoryDefaultAuthority,
  incoming: RepositoryDefaultAuthority
): RepositoryDefaultAuthority {
  if (isReplay(current, incoming)) {
    return current;
  }

  const timeOrder =
    Date.parse(incoming.provenance.observedAt) -
    Date.parse(current.provenance.observedAt);
  if (timeOrder < 0) {
    return current;
  }
  if (timeOrder > 0) {
    return reconcileNewerAuthority(current, incoming);
  }
  return reconcileEqualTimeAuthority(current, incoming);
}

function reconcileNewerAuthority(
  current: RepositoryDefaultAuthority,
  incoming: RepositoryDefaultAuthority
): RepositoryDefaultAuthority {
  if (isAvailable(incoming.evidence)) {
    return incoming;
  }

  const retainedBranch = branchFromEvidence(current.evidence);
  if (retainedBranch === undefined) {
    return incoming;
  }
  return {
    repository: incoming.repository,
    evidence: {
      availability: RepositoryDefaultAvailability.Stale,
      completeness: RepositoryDefaultCompleteness.Partial,
      defaultBranch: retainedBranch,
      reason: incoming.evidence.reason,
    },
    provenance: incoming.provenance,
  };
}

function reconcileEqualTimeAuthority(
  current: RepositoryDefaultAuthority,
  incoming: RepositoryDefaultAuthority
): RepositoryDefaultAuthority {
  const deterministicWinner =
    compareProvenance(incoming, current) < 0 ? incoming : current;

  if (
    "reason" in current.evidence &&
    current.evidence.reason === RepositoryDefaultReason.Conflicting
  ) {
    return deterministicWinner === current
      ? current
      : conflictAuthority(deterministicWinner);
  }
  if (isAvailable(current.evidence)) {
    if (isAvailable(incoming.evidence)) {
      if (current.evidence.defaultBranch !== incoming.evidence.defaultBranch) {
        return conflictAuthority(deterministicWinner);
      }
      return deterministicWinner;
    }
    return current;
  }
  if (isAvailable(incoming.evidence)) {
    return incoming;
  }
  return deterministicWinner;
}

function conflictAuthority(
  provenanceWinner: RepositoryDefaultAuthority
): RepositoryDefaultAuthority {
  return {
    repository: provenanceWinner.repository,
    evidence: {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.Conflicting,
    },
    provenance: provenanceWinner.provenance,
  };
}

function isReplay(
  current: RepositoryDefaultAuthority,
  incoming: RepositoryDefaultAuthority
): boolean {
  return (
    provenanceSourceIdentity(current) === provenanceSourceIdentity(incoming) &&
    current.provenance.observationKey === incoming.provenance.observationKey
  );
}

function compareProvenance(
  left: RepositoryDefaultAuthority,
  right: RepositoryDefaultAuthority
): number {
  const sourceOrder = provenanceSourceIdentity(left).localeCompare(
    provenanceSourceIdentity(right)
  );
  return sourceOrder === 0
    ? left.provenance.observationKey.localeCompare(
        right.provenance.observationKey
      )
    : sourceOrder;
}

function isAvailable(
  evidence: RepositoryDefaultEvidence
): evidence is Extract<
  RepositoryDefaultEvidence,
  { availability: "available" }
> {
  return evidence.availability === RepositoryDefaultAvailability.Available;
}

function branchFromEvidence(
  evidence: RepositoryDefaultEvidence
): string | undefined {
  return "defaultBranch" in evidence ? evidence.defaultBranch : undefined;
}

/** Normalize one persisted row through the same compatibility boundary as reads. */
export function authorityFromStoredRow(
  row: unknown
): RepositoryDefaultAuthority | undefined {
  const parsed = storedRepositoryDefaultAuthoritySchema.safeParse(row);
  if (!parsed.success) {
    return undefined;
  }
  const stored = parsed.data;
  return normalizeRepositoryDefaultAuthority({
    repository: {
      provider: stored.provider,
      providerRepositoryId: stored.providerRepositoryId,
      fullName: stored.repoFullName,
    },
    evidence:
      stored.defaultBranch === null
        ? {
            availability: stored.availability,
            completeness: stored.completeness,
            reason: stored.reason,
          }
        : {
            availability: stored.availability,
            completeness: stored.completeness,
            defaultBranch: stored.defaultBranch,
            ...(stored.reason === null ? {} : { reason: stored.reason }),
          },
    provenance: {
      source: stored.source,
      ...(stored.sourceIdentity === null
        ? {}
        : { sourceIdentity: stored.sourceIdentity }),
      mechanism: stored.mechanism,
      trigger: stored.trigger,
      credentialType: stored.credentialType,
      observationKey: stored.observationKey,
      observedAt: stored.observedAt,
      ...(stored.credentialOwnerId === null
        ? {}
        : { credentialOwnerId: stored.credentialOwnerId }),
      ...(stored.eventAt === null ? {} : { eventAt: stored.eventAt }),
    },
  });
}

function storedRowFromAuthority(
  identityKey: string,
  authority: RepositoryDefaultAuthority,
  updatedAt: string
): StoredRepositoryDefaultAuthority {
  return {
    identityKey,
    provider: authority.repository.provider,
    providerRepositoryId: authority.repository.providerRepositoryId,
    ...storedMutableFields(authority, updatedAt),
  };
}

function storedMutableFields(
  authority: RepositoryDefaultAuthority,
  updatedAt: string
): Omit<
  StoredRepositoryDefaultAuthority,
  "identityKey" | "provider" | "providerRepositoryId"
> {
  return {
    repoFullName: authority.repository.fullName,
    defaultBranch: branchFromEvidence(authority.evidence) ?? null,
    availability: authority.evidence.availability,
    completeness: authority.evidence.completeness,
    reason: "reason" in authority.evidence ? authority.evidence.reason : null,
    source: authority.provenance.source,
    sourceIdentity: authority.provenance.sourceIdentity ?? null,
    mechanism: authority.provenance.mechanism,
    trigger: authority.provenance.trigger,
    credentialType: authority.provenance.credentialType,
    credentialOwnerId: authority.provenance.credentialOwnerId ?? null,
    observationKey: authority.provenance.observationKey,
    observedAt: authority.provenance.observedAt,
    eventAt: authority.provenance.eventAt ?? null,
    updatedAt,
  };
}

function provenanceSourceIdentity(
  authority: RepositoryDefaultAuthority
): string {
  return authority.provenance.sourceIdentity ?? authority.provenance.source;
}

function uniqueReadIdentities(
  repositories: readonly RepositoryDefaultAuthorityReadIdentity[]
): RepositoryDefaultAuthorityReadIdentity[] {
  const unique = new Map<string, RepositoryDefaultAuthorityReadIdentity>();
  for (const repository of repositories) {
    unique.set(
      `${repository.provider}\0${repository.providerRepositoryId}`,
      repository
    );
  }
  return [...unique.values()];
}

function uniqueReadNames(
  repositories: readonly RepositoryDefaultAuthorityReadName[]
): RepositoryDefaultAuthorityReadName[] {
  const unique = new Map<string, RepositoryDefaultAuthorityReadName>();
  for (const repository of repositories) {
    unique.set(`${repository.provider}\0${repository.fullName}`, repository);
  }
  return [...unique.values()];
}

/**
 * `RepositoryDefaultAuthority` is keyed on the compound
 * `@@id([identityKey, provider, providerRepositoryId])` and has no `id` column,
 * so this select IS the whole primary key.
 */
const REPOSITORY_DEFAULT_AUTHORITY_KEY_SELECT = {
  identityKey: true,
  provider: true,
  providerRepositoryId: true,
} as const;
