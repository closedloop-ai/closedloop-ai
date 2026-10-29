import type {
  ArtifactRefRelation as ArtifactRefRelationType,
  SyncedPullRequestArtifactRef,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefRelation,
  PROSE_MENTION_REF_METHODS,
  REPOSITORY_FULL_NAME_MAX_LENGTH,
  SYNCED_PR_URL_MAX_LENGTH,
} from "@repo/api/src/types/session-artifact-link";
import { branchLifecycleEventsForPrLink } from "./branch-lifecycle-events.js";
import { validIso } from "./db-helpers.js";
import type {
  SqliteArtifactLinkRow,
  SqlitePullRequestLifecycleRow,
} from "./db-row-types.js";
import { COMMIT_SHA_CORRELATION_METHOD } from "./pr-link-maintenance.js";
import {
  resolveLinkObservedAt,
  toSessionPrRelationType,
} from "./sync-source-link-fields.js";

const ARTIFACT_REF_RELATION_VALUES = new Set<string>(
  Object.values(ArtifactRefRelation)
);

type PullRequestArtifactRefFacts = Partial<
  Pick<SyncedPullRequestArtifactRef, "title" | "closedAt" | "baseRef">
>;

/** Return a non-empty string within its wire bound. */
export function boundedWireString(
  value: string | null,
  max: number
): string | undefined {
  return value != null && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

/** Build bounded optional PR facts without letting one bad row reject a batch. */
export function buildPullRequestArtifactRefFacts(
  link: SqliteArtifactLinkRow,
  lifecycle: SqlitePullRequestLifecycleRow | undefined
): PullRequestArtifactRefFacts {
  const facts: PullRequestArtifactRefFacts = {};
  const title = boundedWireString(link.title, 1024);
  if (title !== undefined) {
    facts.title = title;
  }
  const closedAt = validTimestamp(lifecycle?.closed_at ?? null);
  if (closedAt !== undefined) {
    facts.closedAt = closedAt;
  }
  // ISS-8175. Bounded to the wire's own `.max(300)` so an oversized local value
  // is OMITTED here rather than failing the batch parse for every session in the
  // tick — the same discipline the other bounded facts above follow.
  const baseRef = boundedWireString(link.base_ref, 300);
  if (baseRef !== undefined) {
    facts.baseRef = baseRef;
  }
  return facts;
}

function validTimestamp(value: string | null): string | undefined {
  return validIso(value) ?? undefined;
}

/** Build the canonical bounded session-to-PR association from one local link. */
export function buildSyncedSessionPrRef(
  link: SqliteArtifactLinkRow
): SyncedSessionPrRef | null {
  const repositoryFullName = boundedWireString(
    link.repo_full_name,
    REPOSITORY_FULL_NAME_MAX_LENGTH
  );
  if (
    link.target_kind !== "pull_request" ||
    repositoryFullName === undefined ||
    link.pr_number == null ||
    PROSE_MENTION_REF_METHODS.has(link.method)
  ) {
    return null;
  }
  const relation =
    toArtifactRefRelation(link.relation) ?? ArtifactRefRelation.Referenced;
  const observedAt =
    link.method === COMMIT_SHA_CORRELATION_METHOD
      ? (link.pr_opened_at ?? undefined)
      : resolveLinkObservedAt(link);
  const branchLifecycleEvents = branchLifecycleEventsForPrLink({
    linkId: link.link_id,
    method: link.method,
    observedAt,
    relation,
  });
  const prUrl = boundedWireString(link.url, SYNCED_PR_URL_MAX_LENGTH);
  return {
    repositoryFullName,
    prNumber: link.pr_number,
    ...(prUrl ? { prUrl } : {}),
    relationType: toSessionPrRelationType(link.relation),
    ...(branchLifecycleEvents.length > 0 ? { branchLifecycleEvents } : {}),
  };
}

function toArtifactRefRelation(
  value: string | null
): ArtifactRefRelationType | undefined {
  return value !== null && ARTIFACT_REF_RELATION_VALUES.has(value)
    ? (value as ArtifactRefRelationType)
    : undefined;
}
