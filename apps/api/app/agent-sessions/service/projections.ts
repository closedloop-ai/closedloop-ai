// Record→DTO projection helpers for agent-session list/detail surfaces.

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
import {
  AgentSessionOrigin,
  AgentSessionState,
  agentSessionStateValidator,
} from "@repo/api/src/types/agent-session";
import { reconcileCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-reconcile";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { DocumentType } from "@repo/api/src/types/document";
import {
  normalizeSessionStatus,
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import type { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import type { BasicUser } from "@repo/api/src/types/user";
import { klocFromLines } from "@repo/api/src/utils/kloc";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
import {
  isBranchFallbackLocSource,
  LOC_SOURCE_GIT,
} from "@repo/api/src/utils/session-loc";
import { deriveAgentSessionFallbackState } from "@repo/lib/sessions/agent-session-detail-projection";
import { formatCurrency } from "@closedloop-ai/loops-api/currency";
import { z } from "zod";
import {
  activityBucketSchema,
  phaseLoopbackSchema,
  sessionMarkerSchema,
  sessionPhaseSchema,
  sessionSpanSchema,
  sessionThrottleSchema,
} from "@/lib/desktop-agent-sessions-schema";
import { toNumber } from "@/lib/prisma-number";
import {
  normalizeNullableString,
  parseJsonArray,
  parseJsonValue,
} from "./coercion";
import { reconcileSessionCost } from "./cost-authority";
import type {
  AgentSessionListRecord,
  SourceArtifactSummaryRecord,
} from "./records";
import { resolveRecordUpdatedAt } from "./session-display-sort";
import type { SourceLinkRecord } from "./session-pr-status";
import {
  resolveAuthoredPrLinkIdentity,
  sessionPullRequestIdentityKey,
  toSessionPullRequestProjection,
} from "./session-pr-status";
import { projectDisplayedSessionStatus } from "./session-status-projection";

export function toBasicUser(
  user: NonNullable<AgentSessionListRecord["user"]>
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

function toSourceArtifactDocumentType(
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

/**
 * ISS-5592: the TERMINAL half of the status→state projection, as an exhaustive
 * `Record<SessionStatus, …>` so a fourth lifecycle status fails `tsc` here until
 * it is intentionally mapped.
 *
 * That guard is the point of the table, and it is what the set-membership test
 * it replaces could not give: `TERMINAL_SESSION_STATUSES.has(status)` followed
 * by `=== INACTIVE` is a runtime check over `string`, so a new member silently
 * fell through to the non-terminal path and reported a finished run as pending
 * or active. This is the same silently-acquires-a-meaning failure ISS-4997
 * removed from the display fold, on the state axis. Only possible now that
 * `normalizeSessionStatus` returns the three-member `SessionStatus` (ISS-5592).
 *
 * `null` is a DELIBERATE mapping, not an omission: ACTIVE is not terminal, so it
 * continues to the awaiting-input and fallback derivations below. A member added
 * to {@link SESSION_STATUS} still has to choose.
 *
 * Why INACTIVE reads `Completed` and not a new `AgentSessionState.Inactive`: the
 * two vocabularies answer different questions. `SESSION_STATUS` is the stored
 * LIFECYCLE of a row; `AgentSessionState` is the OUTCOME the detail page reports
 * (did the run finish, or die). A finished-not-failed run IS `Completed` in
 * outcome terms, so this is the CORRECT projection, not a placeholder — ISS-4654
 * resolved the member as NOT NEEDED, not deferred and not pending a rollout. The
 * full rationale is on `AgentSessionState.Completed`; do not "finish" this by
 * adding a member. ERROR stays its own terminal rather than collapsing to
 * `Blocked` (FEA-4287): the list renders the raw "Failed", so the detail
 * projection must carry the same outcome or the two disagree.
 *
 * ISS-4654: the retired `completed`/`abandoned` keys are gone. A straggler still
 * carrying either folds to INACTIVE upstream and reads `Completed` — which is
 * also why `prSignal` no longer feeds this branch: the FEA-3551 rescue it
 * carried (an orphan-swept `abandoned` run that shipped a merged PR) is moot
 * when both paths agree on `Completed`.
 */
const TERMINAL_AGENT_SESSION_STATE: Record<
  SessionStatus,
  AgentSessionState | null
> = {
  [SESSION_STATUS.INACTIVE]: AgentSessionState.Completed,
  [SESSION_STATUS.ERROR]: AgentSessionState.Error,
  [SESSION_STATUS.ACTIVE]: null,
};

/*
 * ISS-6588 removed this function's second parameter, a PR-outcome signal
 * (FEA-3551) threaded here from the caller's `prProjection`. It had been INERT
 * since ISS-4654 — no input to it could change the returned state — and the
 * branch it fed is gone with the retired spellings that reached it.
 */
export function toAgentSessionState(
  record: Pick<
    AgentSessionListRecord,
    "state" | "artifact" | "awaitingInputSince" | "sessionEndedAt"
  >
): AgentSessionState {
  const parsedState = agentSessionStateValidator.safeParse(record.state);
  if (parsedState.success) {
    return parsedState.data;
  }
  // ISS-4654: fold BEFORE the table lookup, because the table is keyed by
  // `SessionStatus` and only the fold can produce one. Outcomes and their
  // rationale: see {@link TERMINAL_AGENT_SESSION_STATE}.
  const normalizedStatus = normalizeSessionStatus(record.artifact.status);
  const terminalState = TERMINAL_AGENT_SESSION_STATE[normalizedStatus];
  if (terminalState) {
    return terminalState;
  }
  if (record.awaitingInputSince && !record.sessionEndedAt) {
    return AgentSessionState.PendingApproval;
  }
  return deriveAgentSessionFallbackState({
    status: record.artifact.status,
    awaitingInputSince: record.awaitingInputSince,
    endedAt: record.sessionEndedAt,
  });
}

const phaseIterationsSchema = z.record(z.string(), z.number().int().positive());

/**
 * FEA-3562: derive a session's displayed branch from a linked PR's HEAD branch
 * when the session record itself carries no synced local branch. Every PR has a
 * head branch, so a session that surfaces a PR must not render "Branch: None".
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
    // reviewed PR-only link authored no branch and is skipped.
    const hasParticipation = link.branchParticipation != null;
    if (!(hasParticipation || resolveAuthoredPrLinkIdentity(link))) {
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
 * FEA-4250: total lines *changed* (added + removed) for the session's KLOC —
 * the same "added + deleted, not additions only" basis the org/component KLOC
 * uses (`apps/api/app/agent-components/loc-per-dollar.ts`), so a session's efficiency reads
 * on the same basis as the aggregates it rolls into. A missing scalar counts as
 * 0; the shared `klocFromLines` treats a 0 total as "no lines" → null.
 */
function sessionTotalDiffLines(
  record: Pick<AgentSessionListRecord, "linesAdded" | "linesRemoved">
): number {
  return (record.linesAdded ?? 0) + (record.linesRemoved ?? 0);
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
 * Freshness gate: the resolved detail must carry `lastVerifiedAt` (never trust an
 * unverified projection for a LOC/$ figure). `isCurrent` is deliberately NOT
 * required here — a historical (superseded) PR is `isCurrent: false` yet its
 * verified LOC is still the real code the session shipped.
 *
 * Partial-LOC gate (codex P2): a PR is only counted when BOTH `additions` and
 * `deletions` are present. A half-populated row (`additions: 7, deletions: null`)
 * is INCOMPLETE data, not a verified `7`-line total; coercing the missing side to
 * 0 would publish an understated figure as "lines changed in PRs" and feed LOC/$.
 * Such a PR resolves to `null` (unavailable) and contributes nothing — the roll-up
 * degrades to the local working-tree diff rather than an invented undercount.
 *
 * Returns the combined `additions + deletions` when a complete, verified detail
 * matches the PR identity; otherwise `null` (no verified/complete LOC available).
 */
function resolveAuthoredPrLoc(
  link: SourceLinkRecord,
  repositoryFullName: string,
  prNumber: number
): number | null {
  const branch = link.target?.branch;
  if (!branch) {
    return null;
  }
  // Current pointer (`BranchDetail.currentPullRequestDetail`) plus the branch
  // Artifact's full historical PR set (`target.pullRequestDetails`, the
  // Artifact-level `BranchPullRequests` relation) — a superseded PR on a reused
  // branch is `isCurrent: false` and lives only in the historical set.
  const candidates = [
    branch.currentPullRequestDetail,
    ...(link.target?.pullRequestDetails ?? []),
  ];
  const branchRepoRaw = branch.repository?.fullName ?? repositoryFullName;
  for (const detail of candidates) {
    if (
      !detail ||
      detail.lastVerifiedAt == null ||
      detail.number !== prNumber
    ) {
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
      return null;
    }
    return detail.additions + detail.deletions;
  }
  return null;
}

/**
 * FEA-4378: sum the lines *changed* (`additions + deletions`) across the PRs the
 * session AUTHORED, deduped by PR identity. This is the real delivered-code signal
 * for a multi-PR session: the session-level `linesAdded/linesRemoved` scalars are
 * the LOCAL working-tree git diff (via `sumCommitStats`), which collapses to a
 * tiny residual once a session's branches are merged/reset — so a 13-PR session
 * can read `+136 -2` and drive LOC/$ to ~0. Only AUTHORED links count (same
 * {@link resolveAuthoredPrLinkIdentity} gate as the PR-output projection) — a
 * referenced/reviewed PR authored no code for this session.
 *
 * Per-PR LOC comes from {@link resolveAuthoredPrLoc}, which searches the branch's
 * full current+historical detail set (so a superseded PR on a reused branch still
 * counts) and requires a complete, verified row (partial/unknown LOC contributes
 * nothing). Dedup is by repo-scoped identity key, so a PR reachable via multiple
 * authored links — or via both a branch's current pointer and its historical set —
 * is counted exactly once, never double-counted.
 *
 * Returns 0 when no authored PR resolves a complete, verified detail with LOC, so
 * the caller's `max(localDiff, authoredPrLinesChanged)` degrades to the local diff.
 */
function authoredPrLinesChanged(record: AgentSessionListRecord): number {
  const byIdentity = new Map<string, number>();
  for (const link of record.artifact.sourceLinks ?? []) {
    const attributed = resolveAuthoredPrLinkIdentity(link);
    if (!attributed) {
      continue;
    }
    const identityKey = sessionPullRequestIdentityKey(
      attributed.repositoryFullName,
      attributed.prNumber
    );
    // Already resolved a complete, verified LOC for this PR identity via another
    // authored link — never overwrite (or re-add) it, so a PR linked twice or
    // reachable via both the current pointer and the historical set counts once.
    if (byIdentity.has(identityKey)) {
      continue;
    }
    const lines = resolveAuthoredPrLoc(
      link,
      attributed.repositoryFullName,
      attributed.prNumber
    );
    if (lines == null) {
      continue;
    }
    byIdentity.set(identityKey, lines);
  }
  let total = 0;
  for (const lines of byIdentity.values()) {
    total += lines;
  }
  return total;
}

/**
 * FEA-4188: the session's resolved HEAD branch NAME — the branch the session
 * actually worked on, from a source that identifies the head ref: the synced
 * local `branch`, else the linked authored-PR head ref
 * ({@link deriveLinkedPrHeadBranch}), else a touched session→branch link's name
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
  return (
    normalizeNullableString(record.branch) ??
    deriveLinkedPrHeadBranch(record) ??
    touchedBranchName
  );
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
 * A branch is "resolved" only when a real HEAD branch NAME resolves
 * ({@link deriveSessionHeadBranch} — the synced `branch`, a linked authored-PR
 * head ref, or a touched session→branch link's name). It is deliberately NOT
 * satisfied by `baseBranch` (the PR's base/target ref, not its head) nor by a
 * bare branch-artifact id whose target resolved no branch name — either would
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
  transcriptDisposition?: TranscriptDisposition,
  // FEA-4276: the per-session per-event token-cost aggregate, batched for the
  // whole page by `getReconciledCostsBySessionId`
  // ({ count, pricedCount, sum, tokenSum }). When present it is reconciled
  // against the stored rollup by the SAME captured-cost authority
  // (`reconcileSessionCost`) the DETAIL path uses — which trusts the per-event sum
  // only when every counted row was priced (`pricedCount === count`) AND the
  // per-event token counts reconcile with the rollup token total (`tokenSum` is
  // not below it, catching a dropped/overflowed ingest chunk) — so list and detail
  // can never disagree on a session's cost. Absent (undefined) when the caller did
  // not batch it — the row then falls back to the stored rollup as before.
  costAuthority?: {
    count: number;
    pricedCount: number;
    sum: number;
    tokenSum: number;
  }
): AgentSessionListItem {
  const sourceArtifact =
    record.sourceArtifactId && sourceArtifactsById
      ? toSourceArtifactSummary(
          sourceArtifactsById.get(record.sourceArtifactId) ?? null
        )
      : null;
  const user = record.user ? toBasicUser(record.user) : null;
  const storedRollup = toNumber(record.estimatedCost);
  const estimatedCost = costAuthority
    ? reconcileSessionCost({
        tokenEventCount: costAuthority.count,
        pricedEventCount: costAuthority.pricedCount,
        tokenEventCostSum: costAuthority.sum,
        tokenEventTokenSum: costAuthority.tokenSum,
        rollupTokenTotal:
          toNumber(record.inputTokens) + toNumber(record.outputTokens),
        storedRollup,
      })
    : storedRollup;
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
  // FEA-4250/FEA-4378/ISS-4448: project the per-session KLOC + LOC/$ so the read
  // contract carries them and no consumer re-derives. The numerator is
  // `max(localWorkingTreeDiff, branchDiffLines, authoredPrLinesChanged)` — the
  // SAME three signals the detail-view "Lines changed" row resolves, so LOC/$
  // and the displayed figure can never disagree. The session-level
  // `linesAdded/linesRemoved` scalars are the LOCAL working-tree diff, which
  // collapses to a tiny residual once a multi-PR session's branches are
  // merged/reset — so we prefer the branch-level diff or the summed LOC of the
  // PRs the session AUTHORED when either is larger (the real delivered code).
  // `kloc` is null only when ALL signals are 0; `locPerDollar` additionally
  // null when there is no cost.
  //
  // The authored-PR roll-up is gated on the SAME head-branch resolution the PR
  // projection is (`enforcePrBranchInvariant`): a session whose PRs are
  // suppressed (no resolvable head branch — the orphan case) must not count
  // their LOC, or the KLOC numerator and the pills-row "N in PRs" figure would
  // credit a PR the UI renders as "None". `headBranch !== null` is exactly the
  // condition under which the invariant keeps the PRs.
  const localDiffLines = sessionTotalDiffLines(record);
  const prLinesChanged =
    headBranch === null ? 0 : authoredPrLinesChanged(record);
  // ISS-4448: the KLOC numerator must weigh the SAME three real signals the
  // detail-view "Lines changed" row resolves (max of local working-tree diff,
  // branch-level diff, and authored-PR roll-up) so LOC/$ and the displayed
  // figure can never disagree — e.g. a merged 88-PR session that shows "4,004
  // lines changed" (its branch diff) must not compute LOC/$ off the 56-line
  // working-tree residual. `branchDiffStats` carries the branch-level diff.
  const branchDiff = toBranchDiffStats(record);
  const branchDiffLines = branchDiff
    ? branchDiff.linesAdded + branchDiff.linesRemoved
    : 0;
  const totalLines = Math.max(localDiffLines, branchDiffLines, prLinesChanged);
  const kloc = klocFromLines(totalLines);
  const locPerDollar = locPerDollarFromLines(totalLines, estimatedCost);

  return {
    id: record.artifactId,
    slug: record.artifact.slug,
    externalSessionId: record.externalSessionId,
    name: record.artifact.name,
    // FEA-4301: serve the DISPLAYED status, not the raw persisted column. A row
    // awaiting user input stores `active` but DISPLAYS as Waiting
    // (`projectDisplayedSessionStatus`) — the SAME projection the Status-column
    // sort (`compareByDisplayedStatus`) and the Status facet filter
    // (`buildStatusFacetPredicate`) key off. Serving the raw `active` here made
    // the badge render "Active" for a row the sort grouped under Waiting and the
    // WAITING facet returned, so the cell, the sort, and the filter disagreed.
    // Projecting once at the read boundary keeps all three consistent.
    //
    // ISS-5366: the projection also folds an unrecognized status to `unknown`
    // and a long-silent `active` run to `stale`, the two derivations the client
    // mapper applies unconditionally now that `sessions-honest-unknown-states`
    // is retired. Serving the raw column while the badge folded left the row
    // telling two stories — a "Stale" badge inside a page the Active facet
    // returned — so the fold happens here, once, for the cell, the sort, and
    // the facet alike.
    status: projectDisplayedSessionStatus({
      status: record.artifact.status,
      awaitingInputSince: record.awaitingInputSince,
      sessionEndedAt: record.sessionEndedAt,
      lastActivityAt: record.lastActivityAt,
      sessionStartedAt: record.sessionStartedAt,
    }),
    origin: toAgentSessionOrigin(record.origin),
    state: toAgentSessionState(record),
    harness: record.harness,
    cwd: record.cwd,
    repositoryFullName: resolvedRepo,
    repo: resolvedRepo,
    worktreePath: record.worktreePath,
    model: record.model,
    primaryModel,
    models: primaryModel ? [primaryModel] : [],
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
    cost: formatCurrency(estimatedCost),
    wallClock: record.wallClock,
    activeAgent: record.activeAgent,
    waitingUser: record.waitingUser,
    linesAdded: record.linesAdded,
    linesRemoved: record.linesRemoved,
    filesChanged: record.filesChanged,
    kloc,
    locPerDollar,
    // FEA-4378: authored-PR LOC roll-up (see authoredPrLinesChanged) — the real
    // delivered-code figure the detail view surfaces next to the PR pills and
    // the numerator prefers when it exceeds the local working-tree diff.
    authoredPrLinesChanged: prLinesChanged,
    gitDiffStats: toGitDiffStats(record),
    branchDiffStats: branchDiff,
    turns: record.turns,
    toolCallsTotal: record.toolUseCount,
    steeringEpisodes: record.steeringEpisodes,
    autonomy: record.autonomy,
    tokensIn: toNumber(record.inputTokens),
    tokensOut: toNumber(record.outputTokens),
    cache: toNumber(record.cacheReadTokens),
    cacheWrite: toNumber(record.cacheWriteTokens),
    userColor: buildUserColor(user),
    activityBuckets: parseJsonArray<ActivityBucket>(
      record.activityBuckets,
      activityBucketSchema
    ),
    span: parseJsonValue<SessionSpan | null>(
      record.sessionSpan,
      sessionSpanSchema.nullable(),
      null
    ),
    markers: parseJsonArray<SessionMarker>(record.markers, sessionMarkerSchema),
    throttles: parseJsonArray<SessionThrottle>(
      record.throttles,
      sessionThrottleSchema
    ),
    phases: parseJsonArray<SessionPhase>(record.phases, sessionPhaseSchema),
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
    // PLN-1034: fall back to the start time for pre-backfill rows so the column
    // and the default sort always have a real value.
    lastActivityAt: record.lastActivityAt ?? record.sessionStartedAt,
    endedAt: record.sessionEndedAt,
    awaitingInputSince: record.awaitingInputSince,
    // FEA-3479 (PRD-536 G1): cloud upsert freshness for "synced Xs ago".
    lastSyncedAt: record.lastSyncedAt,
    // PRD-536 G1 (Phase 3): session-level transcript verdict (syncing/stale/…)
    // for the list-row freshness affordance, batched per page by the caller.
    transcriptDisposition,
    // PRD-536 E6 / ISS-4621: local↔cloud parity for the per-row disclosure. A
    // row served from the cloud store has its DERIVED-DATA lane synced (it exists
    // in the cloud DB), but the raw-transcript-BLOB lane is INDEPENDENT — so the
    // aggregate is reconciled against the transcript disposition rather than
    // hardcoded `synced`. A session with full derived data but a `main`
    // transcript still `missing`/`uploading` (SES-78221) is honestly `pending`
    // (the cloud copy is behind), not a false `synced`; a terminally-failed or
    // never-expected transcript, or an absent verdict, stays `synced`. See
    // {@link reconcileCloudSyncState}.
    cloudSyncState: reconcileCloudSyncState(transcriptDisposition),
    inputTokens: toNumber(record.inputTokens),
    outputTokens: toNumber(record.outputTokens),
    cacheReadTokens: toNumber(record.cacheReadTokens),
    cacheWriteTokens: toNumber(record.cacheWriteTokens),
    estimatedCost,
    billingMode: record.billingMode ?? null,
    agentCount: record.agentCount,
    toolUseCount: record.toolUseCount,
    errorCount: record.errorCount,
    baseBranch: record.baseBranch,
    sourceArtifactId: record.sourceArtifactId,
    sourceArtifact,
    sourceLoopId: record.sourceLoopId,
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
