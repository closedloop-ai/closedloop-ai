import { z } from "zod";
import { ArtifactType } from "./artifact.ts";
import type { SourceCollaborators } from "./branch-identity.ts";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
  projectArtifactPeople,
} from "./branch-identity.ts";
import { normalizeGitHubActorType } from "./github-actor.ts";

/** Artifact-owned collaborator evidence, shared by every artifact kind. */
export const CollaboratorArtifactType = {
  Session: ArtifactType.Session,
  Branch: ArtifactType.Branch,
  Document: ArtifactType.Document,
  Deployment: ArtifactType.Deployment,
} as const;
export type CollaboratorArtifactType =
  (typeof CollaboratorArtifactType)[keyof typeof CollaboratorArtifactType];

/** The independent persisted sources that can qualify a Session person. */
export const SessionCollaboratorSource = {
  Owner: "owner",
  Comments: "session_comments",
  MetadataEdits: "metadata_edits",
} as const;
export type SessionCollaboratorSource =
  (typeof SessionCollaboratorSource)[keyof typeof SessionCollaboratorSource];

export const ARTIFACT_COLLABORATOR_BATCH_MAX_IDS = 100;
/** Oversized reads fail whole; clients can retry smaller ID groups losslessly. */
export const ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE =
  "collaborator_batch_too_large";

/** The bounded, one-artifact-kind request accepted by the batch read. */
export const artifactCollaboratorBatchQuerySchema = z
  .object({
    artifactType: z.enum(CollaboratorArtifactType),
    artifactIds: z
      .union([z.uuid().transform((id) => [id]), z.array(z.uuid())])
      .pipe(z.array(z.uuid()).min(1).max(ARTIFACT_COLLABORATOR_BATCH_MAX_IDS)),
  })
  .strict();
export type ArtifactCollaboratorBatchQuery = z.infer<
  typeof artifactCollaboratorBatchQuerySchema
>;

/** Session people and independent evidence availability. */
export type SessionCollaborators = SourceCollaborators<
  SessionCollaboratorSource | DirectCollaboratorSource
>;

export type ArtifactCollaboratorEntry = {
  /** Non-deleted native and Liveblocks comments directly on this artifact. */
  commentCount?: number;
} & (
  | {
      artifactId: string;
      artifactType: typeof CollaboratorArtifactType.Session;
      collaborators: SessionCollaborators;
    }
  | {
      artifactId: string;
      artifactType: typeof CollaboratorArtifactType.Branch;
      collaborators: SourceCollaborators<
        BranchCollaboratorSource | DirectCollaboratorSource
      >;
    }
  | {
      artifactId: string;
      artifactType:
        | typeof CollaboratorArtifactType.Document
        | typeof CollaboratorArtifactType.Deployment;
      collaborators: DirectArtifactCollaborators;
    }
);

export const DirectCollaboratorSource = {
  Creator: "creator",
  Interactions: "direct_interactions",
  Comments: "direct_comments",
} as const;
export type DirectCollaboratorSource =
  (typeof DirectCollaboratorSource)[keyof typeof DirectCollaboratorSource];
export type DirectArtifactCollaborators =
  SourceCollaborators<DirectCollaboratorSource>;

/** Authorized IDs only; absent and cross-org IDs both produce no entry. */
export type ArtifactCollaboratorBatchResponse = {
  results: ArtifactCollaboratorEntry[];
};

const availabilitySchema = z.enum(BranchIdentityAvailability);
const wirePersonSchema = z.looseObject({
  provider: z.enum(BranchPersonProvider),
  id: z.string().min(1),
  userId: z.string().nullish(),
  login: z.string().nullish(),
  displayName: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  profileUrl: z.string().nullish(),
  actorType: z.unknown().optional(),
});
const wireEntrySchema = z.looseObject({
  artifactId: z.uuid(),
  artifactType: z.enum(CollaboratorArtifactType),
  commentCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  collaborators: z.looseObject({
    availability: z.unknown().optional(),
    people: z.array(z.unknown()).optional(),
    sources: z.record(z.string(), z.unknown()).optional(),
  }),
});
const wireResponseSchema = z.looseObject({
  results: z.array(wireEntrySchema),
});

/** Parse a cross-process response without promoting missing evidence to empty. */
export function normalizeArtifactCollaboratorBatchResponse(
  raw: unknown,
  expectedType: CollaboratorArtifactType
): ArtifactCollaboratorBatchResponse {
  const parsed = wireResponseSchema.parse(raw);
  const seen = new Set<string>();
  const results: ArtifactCollaboratorEntry[] = [];
  for (const entry of parsed.results) {
    if (entry.artifactType !== expectedType || seen.has(entry.artifactId)) {
      throw new Error("Invalid collaborator batch identity");
    }
    seen.add(entry.artifactId);
    if (entry.artifactType === CollaboratorArtifactType.Session) {
      const sources = normalizeSources(
        entry.collaborators.sources,
        unavailableArtifactCollaborators(CollaboratorArtifactType.Session)
          .sources
      );
      results.push({
        ...(entry.commentCount === undefined
          ? {}
          : { commentCount: entry.commentCount }),
        artifactId: entry.artifactId,
        artifactType: CollaboratorArtifactType.Session,
        collaborators: normalizeCollaborators(entry.collaborators, sources),
      });
    } else if (entry.artifactType === CollaboratorArtifactType.Branch) {
      const sources = normalizeSources(
        entry.collaborators.sources,
        unavailableArtifactCollaborators(CollaboratorArtifactType.Branch)
          .sources
      );
      results.push({
        ...(entry.commentCount === undefined
          ? {}
          : { commentCount: entry.commentCount }),
        artifactId: entry.artifactId,
        artifactType: CollaboratorArtifactType.Branch,
        collaborators: normalizeCollaborators(entry.collaborators, sources),
      });
    } else {
      const sources = normalizeSources(entry.collaborators.sources, {
        [DirectCollaboratorSource.Creator]:
          BranchIdentityAvailability.Unavailable,
        [DirectCollaboratorSource.Interactions]:
          BranchIdentityAvailability.Unavailable,
        [DirectCollaboratorSource.Comments]:
          BranchIdentityAvailability.Unavailable,
      });
      results.push({
        ...(entry.commentCount === undefined
          ? {}
          : { commentCount: entry.commentCount }),
        artifactId: entry.artifactId,
        artifactType: entry.artifactType,
        collaborators: normalizeCollaborators(entry.collaborators, sources),
      });
    }
  }
  return { results };
}

function normalizeSources<TSource extends string>(
  raw: Record<string, unknown> | undefined,
  defaults: Record<TSource, BranchIdentityAvailability>
): {
  sources: Record<TSource, BranchIdentityAvailability>;
  hasUnknown: boolean;
} {
  const sources = { ...defaults };
  const keys = Object.keys(defaults);
  for (const key of keys) {
    const value = raw?.[key];
    const parsed = availabilitySchema.safeParse(value);
    if (parsed.success) {
      sources[key as TSource] = parsed.data;
    } else if (value === undefined) {
      sources[key as TSource] = BranchIdentityAvailability.Unavailable;
    } else {
      sources[key as TSource] = BranchIdentityAvailability.Incomplete;
    }
  }
  return {
    sources,
    hasUnknown: Object.keys(raw ?? {}).some((key) => !keys.includes(key)),
  };
}

function normalizeCollaborators<TSource extends string>(
  raw: z.infer<typeof wireEntrySchema>["collaborators"],
  normalized: {
    sources: Record<TSource, BranchIdentityAvailability>;
    hasUnknown: boolean;
  }
): SourceCollaborators<TSource> {
  const candidates = (raw.people ?? []).map((value) => {
    const parsed = wirePersonSchema.safeParse(value);
    if (!parsed.success) {
      return {};
    }
    const wirePerson = parsed.data;
    const actorType = normalizeGitHubActorType(wirePerson.actorType);
    return {
      ...(actorType ? { actorType } : {}),
      person: {
        provider: wirePerson.provider,
        id: wirePerson.id,
        ...(wirePerson.userId ? { userId: wirePerson.userId } : {}),
        ...(wirePerson.login ? { login: wirePerson.login } : {}),
        ...(wirePerson.displayName
          ? { displayName: wirePerson.displayName }
          : {}),
        ...(wirePerson.avatarUrl ? { avatarUrl: wirePerson.avatarUrl } : {}),
        ...(wirePerson.profileUrl ? { profileUrl: wirePerson.profileUrl } : {}),
        ...(actorType ? { actorType } : {}),
      },
    };
  });
  const projected = projectArtifactPeople(candidates, normalized.sources);
  const stated = availabilitySchema.safeParse(raw.availability);
  if (raw.people === undefined && raw.sources === undefined) {
    projected.availability = BranchIdentityAvailability.Unavailable;
    return projected;
  }
  if (
    normalized.hasUnknown ||
    raw.people === undefined ||
    !stated.success ||
    stated.data === BranchIdentityAvailability.Incomplete
  ) {
    projected.availability = BranchIdentityAvailability.Incomplete;
  } else if (stated.data === BranchIdentityAvailability.Unavailable) {
    projected.availability =
      projected.people.length > 0
        ? BranchIdentityAvailability.Incomplete
        : BranchIdentityAvailability.Unavailable;
  }
  return projected;
}

/** Truthful local or version-skew fallback when no cloud evidence is readable. */
export function unavailableArtifactCollaborators(
  artifactType: typeof CollaboratorArtifactType.Session
): SessionCollaborators;
export function unavailableArtifactCollaborators(
  artifactType: typeof CollaboratorArtifactType.Branch
): SourceCollaborators<BranchCollaboratorSource | DirectCollaboratorSource>;
export function unavailableArtifactCollaborators(
  artifactType:
    | typeof CollaboratorArtifactType.Document
    | typeof CollaboratorArtifactType.Deployment
): DirectArtifactCollaborators;
export function unavailableArtifactCollaborators(
  artifactType: CollaboratorArtifactType
):
  | SessionCollaborators
  | SourceCollaborators<BranchCollaboratorSource | DirectCollaboratorSource>
  | DirectArtifactCollaborators;
export function unavailableArtifactCollaborators(
  artifactType: CollaboratorArtifactType
):
  | SessionCollaborators
  | SourceCollaborators<BranchCollaboratorSource | DirectCollaboratorSource>
  | DirectArtifactCollaborators {
  if (artifactType === CollaboratorArtifactType.Session) {
    return {
      availability: BranchIdentityAvailability.Unavailable,
      people: [],
      sources: {
        ...directUnavailableSources(),
        [SessionCollaboratorSource.Owner]:
          BranchIdentityAvailability.Unavailable,
        [SessionCollaboratorSource.Comments]:
          BranchIdentityAvailability.Unavailable,
        [SessionCollaboratorSource.MetadataEdits]:
          BranchIdentityAvailability.Unavailable,
      },
    };
  }
  if (artifactType !== CollaboratorArtifactType.Branch) {
    return {
      availability: BranchIdentityAvailability.Unavailable,
      people: [],
      sources: {
        [DirectCollaboratorSource.Creator]:
          BranchIdentityAvailability.Unavailable,
        [DirectCollaboratorSource.Interactions]:
          BranchIdentityAvailability.Unavailable,
        [DirectCollaboratorSource.Comments]:
          BranchIdentityAvailability.Unavailable,
      },
    };
  }
  return {
    availability: BranchIdentityAvailability.Unavailable,
    people: [],
    sources: {
      ...directUnavailableSources(),
      [BranchCollaboratorSource.PullRequestAuthors]:
        BranchIdentityAvailability.Unavailable,
      [BranchCollaboratorSource.Pushes]: BranchIdentityAvailability.Unavailable,
      [BranchCollaboratorSource.PullRequestComments]:
        BranchIdentityAvailability.Unavailable,
      [BranchCollaboratorSource.BranchComments]:
        BranchIdentityAvailability.Unavailable,
      [BranchCollaboratorSource.SessionComments]:
        BranchIdentityAvailability.Unavailable,
    },
  };
}

/** Per-ID Local result with explicit unavailable evidence on every source. */
export function unavailableArtifactCollaboratorBatchResponse(
  artifactType: CollaboratorArtifactType,
  artifactIds: readonly string[]
): ArtifactCollaboratorBatchResponse {
  const results: ArtifactCollaboratorEntry[] = [];
  for (const artifactId of new Set(artifactIds)) {
    if (artifactType === CollaboratorArtifactType.Session) {
      results.push({
        artifactId,
        artifactType,
        collaborators: unavailableArtifactCollaborators(artifactType),
      });
    } else if (artifactType === CollaboratorArtifactType.Branch) {
      results.push({
        artifactId,
        artifactType,
        collaborators: unavailableArtifactCollaborators(artifactType),
      });
    } else {
      results.push({
        artifactId,
        artifactType,
        collaborators: unavailableArtifactCollaborators(artifactType),
      });
    }
  }
  return { results };
}

function directUnavailableSources(): Record<
  DirectCollaboratorSource,
  BranchIdentityAvailability
> {
  return {
    [DirectCollaboratorSource.Creator]: BranchIdentityAvailability.Unavailable,
    [DirectCollaboratorSource.Interactions]:
      BranchIdentityAvailability.Unavailable,
    [DirectCollaboratorSource.Comments]: BranchIdentityAvailability.Unavailable,
  };
}
