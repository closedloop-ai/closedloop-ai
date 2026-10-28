// Record→DTO projection helpers for agent-session list/detail surfaces.

import { formatCurrency } from "@closedloop-ai/loops-api/currency";
import { buildUserColor } from "@repo/api/src/agent-session-user-color";
import type {
  ActivityBucket,
  AgentSessionListItem,
  AgentSessionProjectSummary,
  AgentSessionSourceArtifactSummary,
  PhaseIterations,
  PhaseLoopback,
  SessionLinkedArtifact,
  SessionMarker,
  SessionPhase,
  SessionPR,
  SessionSpan,
  SessionThrottle,
} from "@repo/api/src/types/agent-session";
import { AgentSessionOrigin } from "@repo/api/src/types/agent-session";
import { reconcileCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-reconcile";
import type { CanonicalAgentSessionListItem } from "@repo/api/src/types/agent-session-list-contract";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { DocumentType } from "@repo/api/src/types/document";
import type { ArtifactTagPermissions } from "@repo/api/src/types/tag";
import type { SessionTranscriptVerdict } from "@repo/api/src/types/transcript-terminal-skip-disposition";
import type { BasicUser } from "@repo/api/src/types/user";
import { klocFromLines } from "@repo/api/src/utils/kloc";
import {
  locPerDollarFromLines,
  locPerDollarNumeratorLines,
} from "@repo/api/src/utils/loc-per-dollar";
import {
  isBranchFallbackLocSource,
  LOC_SOURCE_GIT,
} from "@repo/api/src/utils/session-loc";
import { z } from "zod";
import { branchCandidatePullRequests } from "@/app/branches/branch-canonical-pull-request";
import { projectArtifactTags } from "@/app/tags/artifact-tag-projection";
import { activityBucketSchema } from "@/lib/desktop-agent-sessions-schema";
import {
  phaseLoopbackSchema,
  sessionMarkerSchema,
  sessionPhaseSchema,
  sessionSpanSchema,
  sessionThrottleSchema,
} from "@/lib/desktop-agent-sessions-trace-schema";
import { toNumber } from "@/lib/prisma-number";
import { isMergedPrDetail } from "@/lib/session-pr-links";
import {
  normalizeNullableString,
  parseCompleteJsonArrayOrEmpty,
  parseJsonArray,
  parseJsonValue,
} from "./coercion";
import type {
  AgentSessionListRecord,
  SessionArtifactOwnershipRecord,
  SourceArtifactSummaryRecord,
} from "./records";
import { statesBranchTouch } from "./session-branch-links";
import { resolveRecordUpdatedAt } from "./session-display-sort";
import type { SourceLinkRecord } from "./session-pr-status";
import {
  resolveAuthoredPrLinkIdentities,
  resolveAuthoredPrLinkIdentity,
  sessionPullRequestIdentityKey,
  toSessionPullRequestProjection,
} from "./session-pr-status";
import { projectDisplayedSessionStatus } from "./session-status-projection";

export function toBasicUser(
  user: NonNullable<AgentSessionListRecord["artifact"]["assignee"]>
): BasicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
  };
}

function toProjectSummary(
  project: AgentSessionListRecord["artifact"]["project"]
): AgentSessionProjectSummary | null {
  if (!project) {
    return null;
  }
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
  };
}

export function toSourceArtifactDocumentType(
  record: Pick<SourceArtifactSummaryRecord, "type" | "subtype">
): DocumentType | null {
  if (record.type !== ArtifactType.Document) {
    return null;
  }
  switch (record.subtype) {
    case DocumentType.Prd:
      return DocumentType.Prd;
    case DocumentType.ImplementationPlan:
      return DocumentType.ImplementationPlan;
    case DocumentType.Feature:
      return DocumentType.Feature;
    case DocumentType.Template:
      return DocumentType.Template;
    case DocumentType.Doc:
      return DocumentType.Doc;
    default:
      return null;
  }
}

function toSourceArtifactSummary(
  record: SourceArtifactSummaryRecord | null | undefined
): AgentSessionSourceArtifactSummary | null {
  if (!record) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    documentType: toSourceArtifactDocumentType(record),
  };
}

function toAgentSessionOrigin(value: string): AgentSessionOrigin {
  return value === AgentSessionOrigin.Loop
    ? AgentSessionOrigin.Loop
    : AgentSessionOrigin.DesktopSync;
}

const phaseIterationsSchema = z.record(z.string(), z.number().int().positive());

/**
 * FEA-3562 / ISS-4742: derive a session's displayed branch from a linked PR's
 * HEAD branch. Every PR has a head branch, so a session that surfaces a PR must
 * not render "Branch: None".
 *
 * Only AUTHORED PR links count (same {@link resolveAuthoredPrLinkIdentity} gate
 * the PR-output projection uses) — a session that merely referenced or reviewed
 * a PR authored no branch, so its head ref must not be attributed as the
 * session's branch. The head branch name is the linked BRANCH artifact's
 * `name` (set to the branch name by `ensureBranchArtifactRow`), read only when
 * the target actually resolves to a branch (`target.branch != null`) so a
 * DOCUMENT-typed target's name can never leak in.
 *
 * `sourceLinks` is ordered `createdAt asc` (see the session-artifact select), so
 * scanning in order and keeping the LAST match yields the most-recent linked
 * PR's head ref — the sensible pick when a session authored several PRs.
 * Returns null when no authored PR link resolves a branch name.
 */
function deriveLinkedPrHeadBranch(
  record: AgentSessionListRecord
): string | null {
  let headBranch: string | null = null;
  for (const link of record.artifact.sourceLinks ?? []) {
    if (!resolveAuthoredPrLinkIdentity(link)) {
      continue;
    }
    const target = link.target;
    // Gate on a resolved BRANCH target: `target.name` is the branch name only
    // for the branch lane; a DOCUMENT target's `name` is the artifact title.
    if (!target?.branch) {
      continue;
    }
    const branchName = normalizeNullableString(target.name);
    if (branchName) {
      headBranch = branchName;
    }
  }
  return headBranch;
}

/**
 * FEA-4256: resolve the artifact id of the BRANCH the session shipped, so the
 * Sessions table and session detail can link the repo/branch/PR display to the
 * session's own branch detail page (`/{org}/branches/{id}`).
 *
 * Rides the same `sourceLinks` relation as the PR/artifact lanes; here we keep
 * only BRANCH-typed targets (branch-links.ts's RELATES_TO edges — see records.ts
 * where the select was widened to include them). A branch is only attributed
 * when the session actually TOUCHED it: a session_branch link (which carries a
 * `branchParticipation`) or an AUTHORED PR link (same {@link
 * resolveAuthoredPrLinkIdentity} gate `deriveLinkedPrHeadBranch` uses). A PR link
 * the session merely REFERENCED or REVIEWED — which still targets a BRANCH
 * artifact but authored no branch — is skipped, so a standup that names a PR
 * cannot mis-link the session to a branch it never shipped.
 *
 * When a session touched several branches, prefer the one it actually WROTE
 * (`branchParticipation === Wrote`) over a merely-reviewed/started branch; among
 * equals, the ordered scan (`createdAt asc`) keeps the LAST, i.e. the most-recent
 * linked branch — mirroring `deriveLinkedPrHeadBranch`'s most-recent-wins pick.
 * Returns null when no branch link resolves, so the display degrades to a
 * non-link chip.
 */
/**
 * FEA-4256/FEA-4188: resolve the session's touched BRANCH link ONCE — both its
 * artifact `id` (for the branch-detail navigation target surfaced as
 * `branchArtifactId`) and its branch `name` (for the head-branch resolution the
 * PR⇒Branch invariant gates on, {@link deriveSessionHeadBranch}). Resolving both
 * from the same chosen link
 * keeps the id and the name in lock-step: the invariant can never be satisfied
 * by an id whose target resolved no branch name (which would still render
 * "Branch: None" alongside the PR).
 *
 * Keeps only BRANCH-typed targets the session genuinely TOUCHED: a
 * session_branch link (carries `branchParticipation`) or an AUTHORED PR link
 * (same {@link resolveAuthoredPrLinkIdentity} gate). A merely referenced/
 * reviewed PR-only link authored no branch and is skipped. Prefers the branch
 * the session actually WROTE (`branchParticipation === Wrote`); among equals the
 * ordered scan (`createdAt asc`) keeps the LAST, i.e. the most-recent link.
 * Both fields are null when no branch link resolves.
 */
type ResolvedBranchLink = {
  id: string;
  name: string | null;
  repositoryFullName: string | null;
};

function deriveTouchedBranchLink(record: AgentSessionListRecord): {
  id: string | null;
  name: string | null;
  repositoryFullName: string | null;
} {
  let wrote: ResolvedBranchLink | null = null;
  let fallback: ResolvedBranchLink | null = null;
  for (const link of record.artifact.sourceLinks ?? []) {
    const target = link.target;
    if (!target?.branch || target.type !== ArtifactType.Branch) {
      continue;
    }
    // Attribute only branches the session genuinely touched: a session_branch
    // link (carries branchParticipation) or an authored PR link. A referenced/
    // reviewed PR-only link authored no branch and is skipped. ISS-8427 moved
    // the rule itself into `statesBranchTouch` so this and the plural
    // `deriveTouchedBranches` cannot drift on what "touched" means.
    if (!statesBranchTouch(link)) {
      continue;
    }
    const resolved = {
      id: target.id,
      name: normalizeNullableString(target.name),
      repositoryFullName: target.branch.repository?.fullName ?? null,
    };
    if (link.branchParticipation === BranchParticipationKind.Wrote) {
      wrote = resolved;
    } else {
      fallback = resolved;
    }
  }
  const chosen = wrote ?? fallback;
  return {
    id: chosen?.id ?? null,
    name: chosen?.name ?? null,
    repositoryFullName: chosen?.repositoryFullName ?? null,
  };
}

/**
 * FEA-3635 / ISS-4449: project the session→Closedloop-artifact links (FEATs/PRDs/
 * PLNs the transcript referenced or created) into clickable link summaries for
 * the session detail. Rides the same `sourceLinks` relation as the PR lane; here
 * we keep only DOCUMENT-typed targets (slug-links.ts's RELATES_TO edges) and skip
 * the branch/PR lanes (BRANCH targets). Deduplicates by target id — a slug can
 * only resolve to one artifact, but the ordered scan keeps the first (earliest)
 * link's role. The order preserves the query's `createdAt asc`.
 *
 * ISS-4449 / ISS-4448: the DOCUMENT refs are budgeted by the desktop producer
 * within {@link MAX_SYNCED_ARTIFACT_REFS} (the cloud validator cap, 500) — with a
 * guaranteed document floor so a PR-heavy session no longer starves them — and a
 * session can resolve dozens of links.
 * Returns the FULL deduped `items` wire set alongside the resolved `total`. The
 * display cap ({@link MAX_DISPLAYED_LINKED_ARTIFACTS}) is applied client-side in
 * the detail view, NOT here: slicing the wire array would make an older installed
 * Desktop that ignores `linkedArtifactsTotal` silently render only the capped set
 * as if it were complete (cross-repo version skew). Keeping the wire field
 * complete lets every client degrade gracefully — it caps its own displayed copy.
 */
export function toLinkedArtifactProjection(record: AgentSessionListRecord): {
  items: SessionLinkedArtifact[];
  total: number;
} {
  const byId = new Map<string, SessionLinkedArtifact>();
  for (const link of record.artifact.sourceLinks ?? []) {
    const target = link.target;
    // Only DOCUMENT-typed targets are session→artifact links; branch/PR lanes
    // target BRANCH artifacts and are handled by the PR projection.
    if (!target || target.type !== ArtifactType.Document) {
      continue;
    }
    if (byId.has(target.id)) {
      continue;
    }
    const meta = link.metadata as Record<string, unknown> | null;
    const role = typeof meta?.role === "string" ? (meta.role as string) : null;
    byId.set(target.id, {
      id: target.id,
      slug: target.slug,
      name: target.name,
      documentType: toSourceArtifactDocumentType(target),
      role,
    });
  }
  const all = [...byId.values()];
  return {
    items: all,
    total: all.length,
  };
}

/**
 * Rehydrate the source-tagged gitDiffStats from the flattened scalar columns.
 * Reconstructed for genuine local-git provenance — both `"git"` (authored-commit
 * sums) and `"branch_fallback"` (FEA-3633: the branch/PR-total fallback the
 * desktop persists into `loc_source` when per-commit enrichment is unavailable),
 * carrying the stored `loc_source` on `source` so the round-trip stays faithful
 * to the provenance this PR records. Loose/estimated scalars (loc_source null or
 * any other value) stay on the plain linesAdded/linesRemoved/filesChanged fields
 * so the UI can tell git-derived LOC apart from agent-estimated LOC.
 */
function toGitDiffStats(
  record: Pick<
    AgentSessionListRecord,
    "locSource" | "linesAdded" | "linesRemoved" | "filesChanged"
  >
): AgentSessionListItem["gitDiffStats"] {
  const source = record.locSource;
  if (
    source == null ||
    (source !== LOC_SOURCE_GIT && !isBranchFallbackLocSource(source))
  ) {
    return null;
  }
  if (
    record.linesAdded == null &&
    record.linesRemoved == null &&
    record.filesChanged == null
  ) {
    return null;
  }
  return {
    linesAdded: record.linesAdded ?? 0,
    linesRemoved: record.linesRemoved ?? 0,
    filesChanged: record.filesChanged ?? 0,
    source,
  };
}

/**
 * Rehydrate the source-tagged branchDiffStats from its dedicated branch_*
 * columns, parallel to {@link toGitDiffStats}. Branch-level LOC owns its own
 * columns (rather than sharing the scalar/loc_source pair), so it round-trips
 * independently of git-derived LOC.
 */
function toBranchDiffStats(
  record: Pick<
    AgentSessionListRecord,
    | "branchLocSource"
    | "branchLinesAdded"
    | "branchLinesRemoved"
    | "branchFilesChanged"
  >
): AgentSessionListItem["branchDiffStats"] {
  // Provenance gate, parallel to toGitDiffStats' `locSource !== "git"` check:
  // applyBranchDiffStatsPatch writes branch_loc_source atomically with the
  // numeric columns, so a missing source means there is no recorded branch LOC
  // to rehydrate. Gating here keeps the round-trip faithful — the source is read
  // back as stored rather than guessed.
  if (record.branchLocSource == null) {
    return null;
  }
  if (
    record.branchLinesAdded == null &&
    record.branchLinesRemoved == null &&
    record.branchFilesChanged == null
  ) {
    return null;
  }
  return {
    linesAdded: record.branchLinesAdded ?? 0,
    linesRemoved: record.branchLinesRemoved ?? 0,
    filesChanged: record.branchFilesChanged ?? 0,
    source: record.branchLocSource,
  };
}

/**
 * FEA-4378 (codex P2): resolve one authored PR's `(repositoryFullName, prNumber)`
 * to its lines-changed, searching the linked branch's FULL PR-detail set — the
 * `currentPullRequestDetail` pointer AND the historical `pullRequestDetails[]`
 * rows — not just the current pointer. A session that authors PR #2 from a branch
 * that already held PR #1 moves the branch's `currentPullRequestDetail` to #2, so
 * reading only the current pointer would silently drop #1's delivered code from
 * the roll-up. Matching by `number` + normalized repo across the whole per-branch
 * set recovers a superseded PR's LOC.
 *
 * Merge + freshness gate (ISS-6114): the resolved detail must satisfy
 * `isMergedPrDetail` — verified (`lastVerifiedAt`), `prState = MERGED`, and a
 * non-null `mergedAt`. `isCurrent` is deliberately NOT required — a historical
 * (superseded) PR is `isCurrent: false` yet, once merged, its LOC is still real
 * code the session shipped.
 *
 * Partial-LOC gate (codex P2): a PR is only counted when BOTH `additions` and
 * `deletions` are present. A half-populated row (`additions: 7, deletions: null`)
 * is INCOMPLETE data, not a verified `7`-line total; coercing the missing side to
 * 0 would publish an understated figure as "lines changed in merged PRs" and
 * feed LOC/$.
 * Such a PR resolves to `null` (unavailable) and contributes nothing — the roll-up
 * degrades to the local working-tree diff rather than an invented undercount.
 *
 * ISS-9980 (RULED 2026-09-11): the two reasons this can decline to return a
 * number are NOT the same fact and no longer share a `null`. "No candidate row
 * matched" (`excluded`) is a measured answer — this identity contributes 0 and
 * the session's merged total is still knowable. "A matching merged row exists
 * but its LOC is unreachable" (`unknowable`) is the ISS-4448 shape: we looked,
 * the code is real, and we cannot say how much of it there is. Collapsing the
 * second into the first is what let a session with 88 merged PRs report a
 * confident `0` merged LOC, which is a false measurement, not a small one.
 */
type AuthoredPrLocResolution =
  | { kind: "counted"; lines: number }
  | { kind: "excluded" }
  | { kind: "unknowable" };

function resolveAuthoredPrLoc(
  link: SourceLinkRecord,
  repositoryFullName: string,
  prNumber: number,
  { mergedOnly }: { mergedOnly: boolean }
): AuthoredPrLocResolution {
  const branch = link.target?.branch;
  if (!branch) {
    return { kind: "excluded" };
  }
  // Current pointer (`BranchDetail.currentPullRequestDetail`) plus the branch
  // Artifact's full historical PR set (`target.pullRequestDetails`, the
  // Artifact-level `BranchPullRequests` relation) — a superseded PR on a reused
  // branch is `isCurrent: false` and lives only in the historical set.
  const candidates = branchCandidatePullRequests(
    branch,
    link.target?.pullRequestDetails
  );
  const branchRepoRaw = branch.repository?.fullName ?? repositoryFullName;
  for (const detail of candidates) {
    // Freshness is UNCONDITIONAL: never trust an unverified projection for a
    // LOC figure. This used to read as one guard with the merge check folded
    // into `isMergedPrDetail` below — but that check is behind `mergedOnly`, so
    // folding it there silently dropped freshness from the gate-CLOSED path and
    // let an unverified row reach `authoredPrLinesChanged`, which is also the
    // value the deprecated alias ships to installed Desktop builds.
    if (
      detail == null ||
      detail.lastVerifiedAt == null ||
      detail.number !== prNumber
    ) {
      continue;
    }
    // ISS-6114: MERGED, not merely authored. Cosimo's ruling (2026-09-01) on the
    // decision this ticket was filed to force: the LOC rung means merged code.
    //
    // Through the canonical `isMergedPrDetail` rather than a fresh
    // `prState === Merged` check, because that predicate is already the
    // definition the Sessions-list "LOC / $" card runs on, and it has a
    // Prisma mirror (`MERGED_PR_DETAIL_WHERE`) that is required to stay in
    // lockstep with it. A second hand-written spelling here is how the two
    // surfaces came to disagree in the first place: one gated on merge, one did
    // not, and the same session answered "how much PR code is this" two ways.
    //
    // `isMergedPrDetail` also requires `lastVerifiedAt`, but that is NOT why the
    // guard above exists: this branch runs only when `mergedOnly` is true, so it
    // is the merge half that is conditional and freshness that is not.
    //
    // DELIBERATELY STRICTER THAN THE PR PILLS RENDERED ONE ROW ABOVE THIS
    // FIGURE (ISS-6114 review). `derivePrLifecycleStatus`
    // (`packages/lib/session-trace/derivation.ts`) classifies Merged with an OR
    // — `mergedAt || prState === Merged` — while this is an AND over
    // `lastVerifiedAt`, `prState`, and a non-null `mergedAt`. So a row carrying
    // `prState = MERGED` with a null `mergedAt` shows a Merged PILL while
    // contributing nothing here, and the panel reads "Merged" above "in
    // session". That shape is writable: `buildPullRequestDetailUpdate`
    // (`app/branches/github-projection-writer.ts`) writes `prState`
    // unconditionally but `mergedAt` only when the producer supplies one, so a
    // provenance-poorer producer cannot null a measured timestamp.
    //
    // The asymmetry is intended — a LOC figure must not count a merge it has no
    // merge TIMESTAMP for, whereas a pill only claims lifecycle — but it is an
    // undercount, so the rung degrades to the branch/local diff rather than
    // publishing a number it cannot stand behind. Pinned below.
    if (mergedOnly && !isMergedPrDetail(detail)) {
      continue;
    }
    const detailRepoRaw =
      detail.repository?.fullName ?? detail.repositoryFullName ?? branchRepoRaw;
    if (
      !detailRepoRaw ||
      normalizeRepoFullName(detailRepoRaw) !==
        normalizeRepoFullName(branchRepoRaw)
    ) {
      continue;
    }
    // Both sides required: a half-populated row is unavailable, not a verified
    // partial total. Distinguishes true-zero (0 + 0, a real no-op PR) from unknown.
    if (detail.additions == null || detail.deletions == null) {
      return { kind: "unknowable" };
    }
    return { kind: "counted", lines: detail.additions + detail.deletions };
  }
  return { kind: "excluded" };
}

/**
 * FEA-4378 / ISS-6114: sum the lines *changed* (`additions + deletions`) across
 * the MERGED PRs the session authored, deduped by PR identity.
 *
 * MERGED IS THE POINT, and it is a decision rather than an implementation
 * detail. This roll-up counted every authored PR with a verified detail row,
 * merged or not, so a session that opened two large PRs and landed neither
 * reported their combined size as delivered code and divided it by cost to
 * report a LOC/$ for work that never shipped — while contributing 0 to the
 * Sessions-list "LOC / $" card, which runs the merge-gated
 * `isMergedPrDetail`. Two surfaces, one question, two populations. Cosimo ruled
 * on 2026-09-01 that the rung means merged LOC, so both now apply the same
 * MERGE gate.
 *
 * THE TWO SURFACES STILL DISAGREE ON ADMISSION, and that half is untouched here
 * (marisolashgrove on #6413). The card reads its numerator PR-side through
 * `sessionLinkedPopulationArms` — the ISS-8153 population, which is the
 * session→PR arms PLUS a non-prose session→branch link, over a scope with the
 * session-activity window stripped. This rung still admits only identities that
 * clear `resolveAuthoredPrLinkIdentities`, which needs a command-derived ref
 * resolving to Authored. So a session on the installation-free lane that reaches
 * its merged PR only through a session→branch link contributes its lines to the
 * card and still reads 0 here. That discrepancy is BY DESIGN and survives this
 * change; do not read "the same merge gate" as "the same population".
 *
 * THE COST, accepted with that ruling and widened by ISS-9964: an in-flight
 * session's PR LOC does not count until its PRs land, and since ISS-9964 there is
 * no branch-diff or working-tree rung left to fall back to — such a session reads
 * `0` merged LOC and an honest `0` LOC/$. That is the point, not a regression:
 * the session-level `linesAdded/linesRemoved` scalars are the LOCAL working-tree
 * git diff (via `sumCommitStats`), which collapses to a tiny residual once a
 * session's branches are merged/reset — so a 13-PR session could read `+136 -2`
 * and drive LOC/$ to ~0 while claiming to measure delivered code. Only AUTHORED
 * links count (same
 * {@link resolveAuthoredPrLinkIdentity} gate as the PR-output projection) — a
 * referenced/reviewed PR authored no code for this session.
 *
 * Per-PR LOC comes from {@link resolveAuthoredPrLoc}, which searches the branch's
 * full current+historical detail set (so a superseded PR on a reused branch still
 * counts) and requires a MERGED, complete, verified row (an open PR, or one with
 * partial/unknown LOC, contributes nothing). Dedup is by repo-scoped identity key, so a PR reachable via multiple
 * authored links — or via both a branch's current pointer and its historical set —
 * is counted exactly once, never double-counted.
 *
 * ISS-9980 (RULED 2026-09-11): `complete` reports whether the total is a
 * MEASUREMENT. Every identity that resolved `excluded` contributes a real 0 — no
 * merged PR, no lines — so a session with nothing merged returns
 * `{ lines: 0, complete: true }` and the caller divides it into an honest `0`
 * LOC/$. An identity that resolved `unknowable` makes the SUM unknowable, not
 * smaller: the session merged code whose size this projection cannot reach, and
 * `{ complete: false }` is what stops the caller publishing the residue as a
 * verified figure. Callers that still want the lossy legacy behaviour read
 * `lines` and ignore `complete` — see the `authoredPrLinesChanged` emit below.
 */
function authoredPrLinesChangedFor(
  record: AgentSessionListRecord,
  { mergedOnly }: { mergedOnly: boolean }
): { lines: number; complete: boolean } {
  const byIdentity = new Map<string, number>();
  const unknowableIdentities = new Set<string>();
  for (const link of record.artifact.sourceLinks ?? []) {
    for (const attributed of resolveAuthoredPrLinkIdentities(link)) {
      const identityKey = sessionPullRequestIdentityKey(
        attributed.repositoryFullName,
        attributed.prNumber
      );
      if (byIdentity.has(identityKey)) {
        continue;
      }
      const resolved = resolveAuthoredPrLoc(
        link,
        attributed.repositoryFullName,
        attributed.prNumber,
        { mergedOnly }
      );
      if (resolved.kind === "unknowable") {
        unknowableIdentities.add(identityKey);
        continue;
      }
      if (resolved.kind === "excluded") {
        continue;
      }
      byIdentity.set(identityKey, resolved.lines);
    }
  }
  let lines = 0;
  for (const counted of byIdentity.values()) {
    lines += counted;
  }
  // `complete` is derived AFTER the loop, not latched inside it, so it cannot
  // depend on `sourceLinks` order. One identity can be reached by several links
  // — a reused branch, or a PR held by both a branch's current pointer and its
  // historical set — and one of those links resolving `unknowable` does not make
  // the PR unreadable if ANOTHER link read it. Latching on the first unknowable
  // made the SUM take the last counted resolution while the VERDICT took the
  // first, so a session whose merged total was fully counted still reported
  // `mergedAuthoredPrLinesChanged: null` purely from the order its links
  // happened to be iterated in. Only an identity nothing ever counted makes the
  // total NOT KNOWABLE.
  const complete = [...unknowableIdentities].every((identityKey) =>
    byIdentity.has(identityKey)
  );
  return { lines, complete };
}

/**
 * FEA-4188 / ISS-4742: the session's resolved HEAD branch NAME — the branch the
 * session actually worked on, from a source that identifies the head ref: the
 * linked authored-PR head ref ({@link deriveLinkedPrHeadBranch}), else a touched
 * session→branch link's name
 * ({@link deriveTouchedBranchLink}). Deliberately EXCLUDES `baseBranch` — that
 * is the PR's base/target ref (e.g. `main`), NOT its head, so it can never
 * stand in for the head branch a PR was opened from.
 *
 * This is the value the PR⇒Branch invariant ({@link enforcePrBranchInvariant})
 * gates on: a rendered PR is orphaned unless a real head branch resolves here.
 * Gating on `baseBranch` would let an orphaned PR launched with
 * `baseBranch = main` pass the invariant against a base ref it was never opened
 * from; gating on a bare branch-artifact id would let a link whose target
 * resolved no branch NAME pass while the row still shows "Branch: None".
 * Normalized so a blank/whitespace value reads as "no branch".
 */
function deriveSessionHeadBranch(
  record: AgentSessionListRecord,
  touchedBranchName: string | null
): string | null {
  return deriveLinkedPrHeadBranch(record) ?? touchedBranchName;
}

/**
 * FEA-3562: the session's DISPLAYED branch — the resolved head branch
 * ({@link deriveSessionHeadBranch}), else a display-only fall back to
 * `baseBranch` for a read-only session that authored no PR and touched no
 * branch, so such a session still shows something rather than "None". The base
 * fallback is display-only: it does NOT satisfy the PR⇒Branch invariant (that
 * gates on {@link deriveSessionHeadBranch}), so a session surfacing a PR never
 * renders its base in place of the head.
 */
function deriveSessionBranch(
  headBranch: string | null,
  record: AgentSessionListRecord
): string | null {
  return headBranch ?? normalizeNullableString(record.baseBranch);
}

/**
 * FEA-4188 (recurrence): enforce the read-boundary invariant that a rendered
 * session with ≥1 PR must carry a non-null Branch identifying the corresponding
 * head branch (PR present ⇒ Branch present). The two lanes — the PR projection
 * ({@link toSessionPullRequestProjection}) and the branch derivation
 * ({@link deriveSessionBranch}) — are assembled INDEPENDENTLY, so nothing else
 * prevents the impossible state where a PR renders with Branch = None
 * (session→branch→PR attribution/navigation is broken there).
 *
 * The prior fix (#3801) suppressed orphaned authored PR writes in the DESKTOP
 * SQLite local read path only; it did not cover the CLOUD projection, where a PR
 * associated via desktop-reported legacy JSON or the sync/enrichment source-link
 * lanes can still surface with no resolved branch. This gate closes that path for
 * ALL PR-association routes at the single cloud read boundary
 * ({@link toSessionListItem} — list + detail), so list, Properties, and
 * navigation all inherit it.
 *
 * A branch is "resolved" only when a real HEAD branch NAME resolves: a linked
 * authored-PR head ref or a touched session→branch link's name. It is
 * deliberately NOT satisfied by `baseBranch` (the PR's base/target ref, not its
 * head) nor by a bare branch-artifact id whose target resolved no branch name —
 * either would
 * let a PR render alongside a row that still shows "Branch: None", the exact
 * orphaned state this gate exists to forbid.
 *
 * Compat (never crash): when no head branch resolves, SUPPRESS the PRs from the
 * rendered set rather than fabricate a branch, and reset the derived merged
 * count so it can't outlive the PRs it counted. A session that does resolve a
 * head branch keeps its PRs unchanged.
 */
function enforcePrBranchInvariant(
  prProjection: { prs: SessionPR[]; verifiedMergedCount: number },
  headBranch: string | null
): { prs: SessionPR[]; verifiedMergedCount: number } {
  if (headBranch !== null || prProjection.prs.length === 0) {
    return prProjection;
  }
  return { prs: [], verifiedMergedCount: 0 };
}

export function toSessionListItem(
  record: AgentSessionListRecord,
  sourceArtifactsById?: Map<string, SourceArtifactSummaryRecord>,
  // PRD-536 G1 (Phase 3): per-session transcript verdict for the LIST-row
  // freshness affordance, derived once for the whole page and looked up by
  // session identity. Omitted (undefined) when the caller did not batch it
  // (e.g. the by-ids reader) or the session has no transcript rows yet — the
  // row then shows only the `lastSyncedAt` freshness, never a fabricated verdict.
  //
  // ISS-9884: the VERDICT PAIR, not the bare disposition. `failedTransient` is
  // reached both by an ordinary retryable upload failure and by an
  // environmental give-up, and the renderers have to tell those apart, so the
  // reason that produced the disposition rides beside it.
  transcriptVerdict?: SessionTranscriptVerdict,
  // FEA-4204: the session's comment thread count, batched for the whole
  // page by `loadListCommentCounts`. `undefined` means the caller did not batch
  // it, and the field is OMITTED rather than serialized as 0 — absent is "no
  // count available", which the client renders as no tag; a computed zero
  // arrives as a real `0`.
  commentCount?: number,
  // FEA-4222: values attached to this Session artifact, loaded once for the
  // page. `undefined` means the producer did not complete the projection and
  // is omitted; a successful read with no values is an explicit empty array.
  customFields?: CustomFieldValueDetail[],
  // ISS-8712: the caller's org, plus the auth-derived tag capabilities. Both are
  // REQUIRED to project tags at all: the relation is joined on the page's SELECT
  // (see `records.ts`), but a projection that could not name the caller's org
  // would have to trust the join's own scoping as its only check, and the
  // permissions are what the client reads to decide whether to offer the picker.
  // Omitted by callers that do not serve a tag-bearing surface — the row then
  // reports `Unavailable` rather than an empty tag list it never read.
  tagContext?: { organizationId: string; permissions: ArtifactTagPermissions }
): CanonicalAgentSessionListItem {
  const sourceArtifact =
    record.sourceArtifactId && sourceArtifactsById
      ? toSourceArtifactSummary(
          sourceArtifactsById.get(record.sourceArtifactId) ?? null
        )
      : null;
  // ISS-12585: the deprecated `user` alias carries the Owner, the artifact
  // assignee; the recording user it used to name is retired.
  const user = record.artifact.assignee
    ? toBasicUser(record.artifact.assignee)
    : null;
  // ISS-7176: the WHOLE-SESSION cost is `session_detail.estimated_cost`, read
  // straight through.
  //
  // This row used to reconcile against a per-event sum and prefer it. That was
  // backwards. The desktop rollup adds a session-level WEB-SEARCH line item
  // (`webSearchCostSql`, billed per request rather than per token) that no
  // `agent_session_token_events` row carries, and the completeness gate guarding
  // the swap compared token COUNTS — web search contributes none, so the gate
  // passed, the per-event sum won, and the web-search dollars silently vanished
  // from the displayed figure.
  //
  // AND THE STREAM IS INCOMPLETE ANYWAY, which ISS-7515 measured against the
  // real desktop store rather than inferring: on the largest session there —
  // 8.26B tokens / $6,229.94 across three models — `agent_session_token_events`
  // held 97 rows for a session whose parent transcript alone records 1,016 agent
  // turns. Preferring the per-event sum would have displayed $17.73. That case
  // survived only because the rollup was the fallback; the web-search case above
  // is the same failure where the completeness gate could not see it.
  //
  // Per-event sums remain the right tool for pricing PART of a session (a
  // branch's share, a windowed slice); they are not a whole-session total. See
  // ISS-7176 v3 for the rule and `packages/app/branches` for the part-of case.
  //
  // ISS-12260: a NULL column (never priced) is served as `null`, never as `0`.
  const estimatedCost =
    record.estimatedCost == null ? null : toNumber(record.estimatedCost);
  const primaryModel = record.model;
  // FEA-4188: resolve the head branch first, then enforce the PR⇒Branch
  // read-boundary invariant BEFORE `prs`/`prsMerged`/the state signal read the
  // projection, so a PR that resolves no head branch NAME is suppressed once
  // here and list + detail + navigation all inherit it. `baseBranch` and a bare
  // branch-artifact id are display/navigation aids only — neither satisfies the
  // gate (see {@link enforcePrBranchInvariant}).
  const touchedBranch = deriveTouchedBranchLink(record);
  const headBranch = deriveSessionHeadBranch(record, touchedBranch.name);
  const branch = deriveSessionBranch(headBranch, record);
  const branchArtifactId = touchedBranch.id;
  const resolvedRepo =
    touchedBranch.repositoryFullName ?? record.repositoryFullName;
  const prProjection = enforcePrBranchInvariant(
    toSessionPullRequestProjection(record),
    headBranch
  );
  const prs = prProjection.prs;
  const linkedArtifactProjection = toLinkedArtifactProjection(record);
  const linkedArtifacts = linkedArtifactProjection.items;
  // ISS-9964 / ISS-9980 (RULED 2026-09-11): the per-session KLOC + LOC/$ are
  // projected here so the read contract carries them and no consumer re-derives.
  // The numerator is `mergedAuthoredPrLinesChanged` and NOTHING ELSE — the lines
  // this session actually landed. The FEA-4250/ISS-4448 rungs (the local
  // working-tree diff and the branch-level diff) are retired: both measure work
  // in progress, and mixing them into a delivered-code rate is what let a
  // session's LOC/$ move because a branch was pushed. Branches LOC/$ counts
  // lines pushed to origin (ISS-9958); that difference is deliberate.
  //
  // The roll-up is gated on the SAME head-branch resolution the PR projection is
  // (`enforcePrBranchInvariant`): a session whose PRs are suppressed (no
  // resolvable head branch — the orphan case) must not count their LOC, or the
  // numerator and the pills-row figure would credit a PR the UI renders as
  // "None". But a suppressed projection is not a measured zero — we know the PRs
  // are there and have refused to read them — so it is NOT KNOWABLE, and
  // `mergedAuthoredPrLinesChanged` is sent as `null` rather than as `0`. The
  // key is always present (the type declares it nullable); it is the VALUE that
  // carries the distinction, and `null` is the wire spelling of not-knowable.
  //
  // `authoredPrLinesChanged` (every authored PR, merged or not) is still emitted
  // unchanged for version-skewed Desktop builds that read only that key. It is a
  // COMPATIBILITY field, not a numerator: nothing in this repo divides by it.
  const authoredPrLines =
    headBranch === null
      ? 0
      : authoredPrLinesChangedFor(record, { mergedOnly: false }).lines;
  const mergedAuthoredPrLoc =
    headBranch === null
      ? null
      : authoredPrLinesChangedFor(record, { mergedOnly: true });
  const mergedAuthoredPrLines =
    mergedAuthoredPrLoc?.complete === true ? mergedAuthoredPrLoc.lines : null;
  const branchDiff = toBranchDiffStats(record);
  // ISS-6113: the numerator rule lives in ONE place
  // (`locPerDollarNumeratorLines`), because it was written out here and again in
  // the detail override, and the copies drifted.
  const totalLines = locPerDollarNumeratorLines({
    mergedAuthoredPrLinesChanged: mergedAuthoredPrLines,
  });
  const kloc = totalLines === null ? null : klocFromLines(totalLines);
  const locPerDollar = locPerDollarFromLines(totalLines, estimatedCost);

  return {
    id: record.artifactId,
    slug: record.artifact.slug,
    externalSessionId: record.externalSessionId,
    // ISS-8717: the owner's rename wins over the collector's placeholder.
    // `artifact.name` is rewritten by every ingest, so it is the placeholder
    // channel and stays recoverable; `nameOverride` is null for a session
    // nobody renamed, which is why the fallback is the whole prior behaviour.
    name: record.nameOverride ?? record.artifact.name,
    // The raw source remains visible for skew diagnosis; the served status is
    // separately folded to the three-value display contract below.
    rawStatus: record.artifact.status,
    // ISS-10332: `null` is a real value (no priority) and IS serialized — the
    // contract declares the field nullable, and omission means "unknown".
    priority: record.artifact.priority,
    status: projectDisplayedSessionStatus({
      status: record.artifact.status,
      awaitingInputSince: record.awaitingInputSince,
      sessionEndedAt: record.sessionEndedAt,
      lastActivityAt: record.lastActivityAt,
      sessionStartedAt: record.sessionStartedAt,
      endsWithError: record.endsWithError,
    }),
    origin: toAgentSessionOrigin(record.origin),
    harness: record.harness,
    cwd: record.cwd,
    repositoryFullName: resolvedRepo,
    repo: resolvedRepo,
    worktreePath: record.worktreePath,
    model: record.model,
    primaryModel,
    // FEA-3562/FEA-4188: the session's HEAD/working branch, resolved once by
    // {@link deriveSessionBranch} and shared with the PR⇒Branch invariant gate
    // above so `branch` and the rendered `prs` can never disagree.
    branch,
    // FEA-4256: the session's own branch-detail target, resolved from the
    // session→branch link. Null (omitted display link) when none resolves.
    // Computed once above and shared with the PR⇒Branch invariant gate.
    branchArtifactId,
    prs,
    prsMerged: prProjection.verifiedMergedCount,
    linkedArtifacts,
    // ISS-4449: the true resolved DOCUMENT-link count before the display cap, so
    // the detail pill row can show an honest "N of M" caption when truncated.
    linkedArtifactsTotal: linkedArtifactProjection.total,
    // FEA-4204: spread-or-omit, never `commentCount: commentCount`. Writing the
    // key unconditionally would put an explicit `undefined` on the object, which
    // `JSON.stringify` drops on the wire but which every in-process consumer
    // (the by-ids reader, tests, the desktop bridge) then reads as a present key
    // — collapsing "not counted" into the same shape as a counted zero.
    ...(commentCount === undefined ? {} : { commentCount }),
    ...(customFields === undefined ? {} : { customFields }),
    // ISS-8712: same spread-or-omit discipline as the two keys above. A caller
    // that passed no `tagContext` gets NO tag keys at all rather than an
    // `Unavailable` it did not compute, which is the honest shape for the
    // by-ids reader and every in-process consumer.
    ...(tagContext === undefined
      ? {}
      : projectArtifactTags(
          record.artifact.tagArtifacts,
          tagContext.organizationId,
          tagContext.permissions
        )),
    cost: estimatedCost === null ? null : formatCurrency(estimatedCost),
    wallClock: record.wallClock,
    activeAgent: record.activeAgent,
    waitingUser: record.waitingUser,
    linesAdded: record.linesAdded,
    linesRemoved: record.linesRemoved,
    filesChanged: record.filesChanged,
    kloc,
    locPerDollar,
    // FEA-4378 / ISS-6114: the authored-PR LOC roll-up the detail view surfaces
    // next to the PR pills. Each field reports what its name says —
    // `authoredPrLinesChanged` every authored PR, `mergedAuthoredPrLinesChanged`
    // the merged subset — so an installed Desktop build reading the older key
    // keeps getting the older meaning. Only the merged field feeds the numerator
    // (ISS-9964), and only it carries the ISS-9980 `null`: absent means the
    // merged total was NOT KNOWABLE, never that nothing merged.
    authoredPrLinesChanged: authoredPrLines,
    mergedAuthoredPrLinesChanged: mergedAuthoredPrLines,
    gitDiffStats: toGitDiffStats(record),
    branchDiffStats: branchDiff,
    // ISS-7737: `turns` spans the PARENT transcript only; the token counters
    // four lines below span the parent PLUS every subagent transcript the
    // desktop collector folded in. Adjacent here, different populations — do not
    // divide one by the other, and do not derive a per-turn cost from the pair.
    turns: record.turns,
    toolCallsTotal: record.toolUseCount,
    steeringEpisodes: record.steeringEpisodes,
    autonomy: record.autonomy,
    tokensIn: toNumber(record.inputTokens),
    tokensOut: toNumber(record.outputTokens),
    cache: toNumber(record.cacheReadTokens),
    cacheWrite: toNumber(record.cacheWriteTokens),
    userColor: buildUserColor(user),
    // ISS-6978: deliberately NOT the member-by-member read. The detail view
    // treats an empty strip as "no persisted buckets" and synthesizes the whole
    // cost strip from turn items instead; a partial strip would be labelled
    // MEASURED while silently understating cost. See
    // `parseCompleteJsonArrayOrEmpty`.
    activityBuckets: parseCompleteJsonArrayOrEmpty<ActivityBucket>(
      record.activityBuckets,
      activityBucketSchema
    ),
    span: parseJsonValue<SessionSpan | null>(
      record.sessionSpan,
      sessionSpanSchema.nullable(),
      null
    ),
    // ISS-6978: same exception as `activityBuckets` — empty routes the detail
    // view to its COMPLETE turn-item-derived markers, and empty `throttles`
    // routes the limit-dot rail to its `throttleSources`/events fallback tier.
    // A partial authoritative array would suppress the richer fallback.
    markers: parseCompleteJsonArrayOrEmpty<SessionMarker>(
      record.markers,
      sessionMarkerSchema
    ),
    throttles: parseCompleteJsonArrayOrEmpty<SessionThrottle>(
      record.throttles,
      sessionThrottleSchema
    ),
    // ISS-6978: same exception, for a sharper reason — `currentPhaseLabel`
    // reads `phases.at(-1)` as the CURRENT phase. The member most likely to
    // fail the schema is the in-flight one (`dur`/`cost` still absent), so a
    // member-by-member read would name the PREVIOUS phase as current instead of
    // falling back to the honest generic label.
    phases: parseCompleteJsonArrayOrEmpty<SessionPhase>(
      record.phases,
      sessionPhaseSchema
    ),
    phaseIterations: parseJsonValue<PhaseIterations>(
      record.phaseIterations,
      phaseIterationsSchema,
      {}
    ),
    phaseLoopbacks: parseJsonArray<PhaseLoopback>(
      record.phaseLoopbacks,
      phaseLoopbackSchema
    ),
    startedAt: record.sessionStartedAt,
    updatedAt: record.sessionUpdatedAt,
    // ISS-6005: the record-mutation clock behind the `Updated` column —
    // MAX(session_detail.updated_at, artifacts.updated_at), the SAME derivation
    // the `?sortBy=updated` comparator orders by (`resolveRecordUpdatedAt`), so
    // the rendered value and the server order cannot drift. Deliberately NOT
    // `sessionUpdatedAt` (the harness-reported recompute stamp serialized as
    // `updatedAt` above), which does not advance on a cloud-side record
    // mutation such as the reaper's status fold.
    // OMITTED, not null, when the caller's select did not project the two
    // columns — `recordUpdatedAt` is an additive optional wire field and the
    // receiving contract does not declare it nullable, so an absent value must
    // stay absent (AGENTS.md → Cross-Repo Compatibility). The consumer renders
    // the shared empty glyph and must NOT substitute `updatedAt` or
    // `lastActivityAt`, which answer different questions.
    ...recordUpdatedAtField(record),
    lastActivityAt: record.lastActivityAt,
    endedAt: record.sessionEndedAt,
    awaitingInputSince: record.awaitingInputSince,
    // FEA-3479 (PRD-536 G1): cloud upsert freshness for "synced Xs ago".
    lastSyncedAt: record.lastSyncedAt,
    // PRD-536 G1 (Phase 3): session-level transcript verdict (syncing/stale/…)
    // for the list-row freshness affordance, batched per page by the caller.
    transcriptDisposition: transcriptVerdict?.disposition,
    // ISS-9884: the terminal skip reason BEHIND that verdict, when one produced
    // it. The KEY is omitted when there is none, not set to `undefined` — an
    // absent optional wire field must stay absent (AGENTS.md → Cross-Repo
    // Compatibility), and the desktop-local producer of the same field omits
    // it, so a consumer testing for the key's presence sees one shape from
    // both.
    ...(transcriptVerdict?.reason
      ? { transcriptDispositionReason: transcriptVerdict.reason }
      : {}),
    // PRD-536 E6 / ISS-4621: local↔cloud parity for the per-row disclosure. A
    // row served from the cloud store has its DERIVED-DATA lane synced (it exists
    // in the cloud DB), but the raw-transcript-BLOB lane is INDEPENDENT — so the
    // aggregate is reconciled against the transcript disposition rather than
    // hardcoded `synced`. A session with full derived data but a `main`
    // transcript still `missing`/`uploading` (SES-78221) is honestly `pending`
    // (the cloud copy is behind), not a false `synced`; a terminally-failed or
    // never-expected transcript, or an absent verdict, stays `synced`. See
    // {@link reconcileCloudSyncState}.
    cloudSyncState: reconcileCloudSyncState(transcriptVerdict?.disposition),
    inputTokens: toNumber(record.inputTokens),
    outputTokens: toNumber(record.outputTokens),
    cacheReadTokens: toNumber(record.cacheReadTokens),
    cacheWriteTokens: toNumber(record.cacheWriteTokens),
    estimatedCost,
    billingMode: record.billingMode ?? null,
    agentCount: record.agentCount,
    toolUseCount: record.toolUseCount,
    componentInvocationCount: record.componentInvocationCount,
    errorCount: record.errorCount,
    baseBranch: record.baseBranch,
    sourceArtifactId: record.sourceArtifactId,
    sourceArtifact,
    // ISS-12435: Loops are removed and the column is ignored; the field stays on
    // the wire as null so version-skewed readers keep their shape.
    sourceLoopId: null,
    user,
    computeTarget: {
      id: record.computeTarget.id,
      machineName: record.computeTarget.machineName,
      isOnline: record.computeTarget.isOnline,
      lastSeenAt: record.computeTarget.lastSeenAt,
      // FEA-3479 (PRD-536 G1) / ISS-4828: target-level LANDED-DATA freshness
      // (when rows from this target last landed) — NOT "last successful sync".
      lastAgentSessionSyncAt: record.computeTarget.lastAgentSessionSyncAt,
      // ISS-4827/ISS-4828: target-level ACCEPTED-sync freshness. Advanced by
      // every accepted batch, including an accepted-but-zero-row one, so a
      // target that is online and syncing with nothing new to send reads as
      // freshly synced here while the landed-data watermark above stays put.
      lastAgentSessionSyncAttemptAt:
        record.computeTarget.lastAgentSessionSyncAttemptAt,
    },
    project: toProjectSummary(record.artifact.project),
    ...artifactOwnershipFields(record.artifact),
  };
}

/**
 * ISS-12197: spread-or-omit for the same reason as {@link recordUpdatedAtField}:
 * a select that did not project a column leaves its key absent rather than
 * serializing a `null` it never read, while a projected column that holds
 * nothing is served as an explicit `null`. `assignee` rides the list select as
 * well as the detail one; the other three are projected on the detail selects
 * only (`sessionArtifactOwnershipSelect`), so a list row omits them. The
 * timestamps are served as ISO strings: this route's payload already declares a
 * `string` `createdAt`, and the client's key-only date reviver cannot carry one
 * key as both.
 */
function artifactOwnershipFields(
  artifact: AgentSessionListRecord["artifact"] &
    Partial<SessionArtifactOwnershipRecord>
): Pick<
  AgentSessionListItem,
  "assignee" | "createdAt" | "createdBy" | "dueDate"
> {
  return {
    ...(artifact.assignee === undefined
      ? {}
      : {
          assignee: artifact.assignee ? toBasicUser(artifact.assignee) : null,
        }),
    ...(artifact.createdAt === undefined
      ? {}
      : { createdAt: artifact.createdAt.toISOString() }),
    ...(artifact.createdBy === undefined
      ? {}
      : {
          createdBy: artifact.createdBy
            ? toBasicUser(artifact.createdBy)
            : null,
        }),
    ...(artifact.dueDate === undefined
      ? {}
      : { dueDate: artifact.dueDate ? artifact.dueDate.toISOString() : null }),
  };
}

/**
 * ISS-6005: the `recordUpdatedAt` wire field, as a SPREADABLE fragment — either
 * `{ recordUpdatedAt: Date }` or `{}`.
 *
 * A fragment rather than a value because the field is additive and OPTIONAL,
 * and the receiving contract does not declare it nullable: an unresolvable
 * record clock must be absent from the payload, not serialized as `null`
 * (AGENTS.md → Cross-Repo Compatibility). Unresolvable means the caller's
 * SELECT did not project the two `@updatedAt` columns — `toSessionListItem` is
 * shared by the list and detail reads, so presence is a property of the query,
 * not of the row.
 */
function recordUpdatedAtField(record: {
  updatedAt?: Date | null;
  artifact?: { updatedAt?: Date | null } | null;
}): { recordUpdatedAt?: Date } {
  const recordUpdatedAt = resolveRecordUpdatedAt(record);
  return recordUpdatedAt ? { recordUpdatedAt } : {};
}
