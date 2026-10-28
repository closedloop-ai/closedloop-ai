import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import type { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  COMMIT_SHA_PATTERN,
  deriveBranchParticipationFromEvidence,
  isLifecycleBranchReadOnlyRelation,
  isLifecycleBranchWriteRelation,
  PROSE_MENTION_REF_METHODS,
  type SyncedArtifactRef,
  type SyncedBranchLifecycleEvent,
  type SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { SessionPrRelationType } from "@repo/api/src/types/session-pr-link-metadata";
import type { StoreLink } from "./store-links";

/**
 * ISS-12017: the golden sessions' store links shaped as the sync wire's
 * `artifactRefs` and `prRefs`. Mirrors the ref assembly in Desktop's
 * `sync-source.ts` (not importable across apps). The perf mapping the golden
 * import reuses omits both arrays, so without them no golden session links to a
 * branch.
 */

export type GoldenSessionRefs = {
  readonly artifactRefs: readonly SyncedArtifactRef[];
  readonly prRefs: readonly SyncedSessionPrRef[];
};

/**
 * The PR facts a Desktop's `gh` enrichment would carry on a pull request ref;
 * the golden store kept none, so the seed derives them from the branch's work.
 */
export type PullRequestFacts = {
  readonly title: string;
  readonly state: GitHubPRState;
  readonly isDraft: boolean;
  readonly baseRef: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly mergedAt?: string;
  readonly closedAt?: string;
};

export type PullRequestFactsLookup = (
  repositoryFullName: string,
  prNumber: number
) => PullRequestFacts | undefined;

type MutableRefs = {
  artifactRefs: SyncedArtifactRef[];
  prRefs: SyncedSessionPrRef[];
};

/** The refs per Desktop session id; sessions without one are absent. */
export function buildGoldenSessionRefs(
  links: readonly StoreLink[],
  factsFor: PullRequestFactsLookup
): ReadonlyMap<string, GoldenSessionRefs> {
  const bySession = new Map<string, MutableRefs>();
  for (const link of links) {
    const refs = bySession.get(link.sessionId) ?? {
      artifactRefs: [],
      prRefs: [],
    };
    appendLink(refs, link, factsFor);
    bySession.set(link.sessionId, refs);
  }
  return new Map(
    [...bySession].filter(([, refs]) => refs.artifactRefs.length > 0)
  );
}

function appendLink(
  refs: MutableRefs,
  link: StoreLink,
  factsFor: PullRequestFactsLookup
): void {
  if (link.kind === ArtifactRefTargetKind.Branch && link.branchName !== null) {
    const relation = link.relation ?? ArtifactRefRelation.Workspace;
    const branchLifecycleEvents = branchLinkLifecycleEvents(link, relation);
    const branchParticipation = deriveBranchParticipationFromEvidence({
      relation,
      method: link.method,
      branchLifecycleEvents,
    });
    refs.artifactRefs.push({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: link.repositoryFullName,
      branchName: link.branchName,
      method: link.method,
      relation,
      ...(branchParticipation === undefined ? {} : { branchParticipation }),
      ...observedAtField(link),
      ...lifecycleField(branchLifecycleEvents),
    });
    return;
  }
  if (
    link.kind === ArtifactRefTargetKind.PullRequest &&
    link.prNumber !== null
  ) {
    appendPullRequestLink(refs, link, link.prNumber, factsFor);
    return;
  }
  appendCommitLink(refs, link);
}

function appendPullRequestLink(
  refs: MutableRefs,
  link: StoreLink,
  prNumber: number,
  factsFor: PullRequestFactsLookup
): void {
  const relation = link.relation ?? ArtifactRefRelation.Referenced;
  const branchLifecycleEvents = pullRequestLinkLifecycleEvents(link, relation);
  const facts =
    link.branchName === null
      ? undefined
      : factsFor(link.repositoryFullName, prNumber);
  refs.artifactRefs.push({
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: link.repositoryFullName,
    prNumber,
    method: link.method,
    relation,
    ...(link.branchName === null ? {} : { branchName: link.branchName }),
    ...observedAtField(link),
    ...lifecycleField(branchLifecycleEvents),
    ...facts,
  });
  if (!PROSE_MENTION_REF_METHODS.has(link.method)) {
    refs.prRefs.push({
      repositoryFullName: link.repositoryFullName,
      prNumber,
      relationType: toSessionPrRelationType(relation),
      ...lifecycleField(branchLifecycleEvents),
    });
  }
}

function appendCommitLink(refs: MutableRefs, link: StoreLink): void {
  if (
    link.kind !== ArtifactRefTargetKind.Commit ||
    link.branchName === null ||
    link.sha === null ||
    !COMMIT_SHA_PATTERN.test(link.sha)
  ) {
    return;
  }
  refs.artifactRefs.push({
    kind: ArtifactRefTargetKind.Commit,
    repositoryFullName: link.repositoryFullName,
    branchName: link.branchName,
    sha: link.sha,
    method: link.method,
    relation: link.relation ?? ArtifactRefRelation.Created,
    ...(link.title === null ? {} : { message: link.title }),
    ...(link.committedAt === undefined
      ? {}
      : { committedAt: link.committedAt }),
    ...observedAtField(link),
  });
}

function observedAtField(link: StoreLink): { observedAt?: string } {
  return link.observedAt === undefined ? {} : { observedAt: link.observedAt };
}

function toSessionPrRelationType(
  relation: ArtifactRefRelation
): SessionPrRelationType {
  if (relation === ArtifactRefRelation.Created) {
    return SessionPrRelationType.Created;
  }
  if (relation === ArtifactRefRelation.Reviewed) {
    return SessionPrRelationType.Reviewed;
  }
  return SessionPrRelationType.Referenced;
}

/**
 * ISS-12135: the lifecycle boundaries a Desktop sync stamps on each ref
 * (`apps/desktop/src/main/database/branch-lifecycle-events.ts`, not
 * importable across apps). Branch phase attribution places a session's
 * priced activity only between these boundaries, so without them every
 * seeded branch's cost breakdown reads as unavailable.
 */
function branchLinkLifecycleEvents(
  link: StoreLink,
  relation: ArtifactRefRelation
): SyncedBranchLifecycleEvent[] {
  if (isLifecycleBranchWriteRelation(relation)) {
    return [lifecycleEvent(link, BranchLifecycleBoundaryKind.BranchWrite)];
  }
  if (isLifecycleBranchReadOnlyRelation(relation)) {
    return [
      lifecycleEvent(link, BranchLifecycleBoundaryKind.ReadOnlyReference),
    ];
  }
  return [];
}

function pullRequestLinkLifecycleEvents(
  link: StoreLink,
  relation: ArtifactRefRelation
): SyncedBranchLifecycleEvent[] {
  if (relation === ArtifactRefRelation.Created) {
    return [lifecycleEvent(link, BranchLifecycleBoundaryKind.PrRaised)];
  }
  if (relation !== ArtifactRefRelation.Reviewed) {
    return [];
  }
  return [
    lifecycleEvent(
      link,
      link.method === ArtifactRefMethod.PrReviewFeedbackCommand
        ? BranchLifecycleBoundaryKind.ReviewFeedback
        : BranchLifecycleBoundaryKind.ReadOnlyReference
    ),
  ];
}

function lifecycleEvent(
  link: StoreLink,
  kind: BranchLifecycleBoundaryKind
): SyncedBranchLifecycleEvent {
  return {
    kind,
    evidenceId: `desktop-artifact-link:${link.linkId}`,
    ...observedAtField(link),
  };
}

function lifecycleField(events: readonly SyncedBranchLifecycleEvent[]): {
  branchLifecycleEvents?: SyncedBranchLifecycleEvent[];
} {
  return events.length === 0 ? {} : { branchLifecycleEvents: [...events] };
}
