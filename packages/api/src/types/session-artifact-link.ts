import { z } from "zod";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
  normalizeBranchParticipationKind,
  normalizeRepoFullName,
} from "./branch";
import { GitHubPRState } from "./github-status";
import { syncedMonitoredSessionActivitySchema } from "./session-monitored-activity.ts";
import { buildSlugPrefixAlternation } from "./slug-prefix";
import { syncTimestampSchema } from "./sync-timestamp.ts";

// --- Const-object enums (no `enum` keyword per codebase conventions) ---

export const SessionPrRelationType = {
  Created: "CREATED",
  Referenced: "REFERENCED",
  // FEA-3585: the session REVIEWED this PR (e.g. `gh pr view/diff/review <n>`)
  // rather than authoring it. Distinct from REFERENCED (a mere prose mention)
  // so review sessions are not shown with an authoring state and are attributed
  // to the PR they actually reviewed, not one merely named in the transcript.
  Reviewed: "REVIEWED",
} as const;
export type SessionPrRelationType =
  (typeof SessionPrRelationType)[keyof typeof SessionPrRelationType];

/**
 * Metadata link-kind values used on ArtifactLink rows created from session
 * projections. Values are persisted, so new producers and readers must import
 * these constants instead of duplicating string literals.
 */
export const SessionArtifactLinkKind = {
  SessionPr: "session_pr",
  SessionBranch: "session_branch",
} as const;
export type SessionArtifactLinkKind =
  (typeof SessionArtifactLinkKind)[keyof typeof SessionArtifactLinkKind];

/**
 * Provenance marker stamped on session→artifact link metadata so readers can
 * tell how a link was produced. Desktop-sync is currently the only writer of
 * `session_branch` links (FEA-2729).
 */
export const SessionArtifactLinkMetadataSource = {
  DesktopSync: "desktop_sync",
} as const;
export type SessionArtifactLinkMetadataSource =
  (typeof SessionArtifactLinkMetadataSource)[keyof typeof SessionArtifactLinkMetadataSource];

export const SessionPrPurpose = {
  Authored: "authored",
  // FEA-3585: the session reviewed this PR (did not author it). Ranked between
  // Authored and Referenced by chooseStrongerSessionPrPurpose — a review is a
  // stronger, deliberate relationship than a bare prose mention (Referenced),
  // but must NOT be counted as authoring output (preserves FEA-3584 gating).
  Reviewed: "reviewed",
  Referenced: "referenced",
  Unknown: "unknown",
} as const;
export type SessionPrPurpose =
  (typeof SessionPrPurpose)[keyof typeof SessionPrPurpose];

export const SESSION_PR_PURPOSE_LABELS: Record<SessionPrPurpose, string> = {
  [SessionPrPurpose.Authored]: "Authored PR",
  [SessionPrPurpose.Reviewed]: "Reviewed PR",
  [SessionPrPurpose.Referenced]: "Referenced PR",
  [SessionPrPurpose.Unknown]: "Unknown PR purpose",
};

export const ArtifactRefMethod = {
  McpToolCall: "mcp_tool_call",
  UrlInMessage: "url_in_message",
  SlugInMessage: "slug_in_message",
  SlugInBranch: "slug_in_branch",
  SlugInCwd: "slug_in_cwd",
  SlugInSessionSlug: "slug_in_session_slug",
  PrCreateOutput: "pr_create_output",
  PrUrlInToolUse: "pr_url_in_tool_use",
  // FEA-3585: a `gh pr view/diff/review/checkout/comment <n>` review command.
  PrReviewCommand: "pr_review_command",
  // FEA-3803: a PR feedback write command (`gh pr review` / `gh pr comment`).
  // Kept distinct from read-only view/diff/checkout refs so review phase
  // attribution does not treat passive context as feedback.
  PrReviewFeedbackCommand: "pr_review_feedback_command",
  HarnessPrLink: "harness_pr_link",
  LaunchMetadata: "launch_metadata",
  GitCommand: "git_command",
  // ISS-5764: a PR named in PROSE adjacent to PR vocabulary (`PR #4710`, a
  // markdown table's `PR` column), with no `gh` command anywhere. Always paired
  // with `ArtifactRefRelation.Referenced` — a mention is not authorship.
  PrMentionInProse: "pr_mention_in_prose",
  // ISS-5764: a branch named in PROSE adjacent to branch vocabulary. Distinct
  // from every `git_*` method: those are write/read COMMANDS this session ran.
  BranchMentionInProse: "branch_mention_in_prose",
} as const;
export type ArtifactRefMethod =
  (typeof ArtifactRefMethod)[keyof typeof ArtifactRefMethod];

/**
 * ISS-5764: the methods produced by the extractor's prose-mention pass — the
 * weakest evidence any ref can carry. Two consumers must treat them specially,
 * and BOTH are cases where admitting a mention as ordinary evidence would
 * DELETE a real PR rather than merely add a weak one:
 *
 *  1. **The desktop producer budget** (`artifact-ref-budget.ts`) sheds these
 *     first, so a session that mentions hundreds of PRs cannot evict the
 *     `created` ref for the one it actually authored.
 *  2. **The `prRefs` sync carrier** (`sync-source.ts`) omits them entirely.
 *     That array is the sole input to {@link toSessionPrEvidenceRecords}, where
 *     every non-`CREATED` entry ADJUDICATES its PR number — including the
 *     repo-less `legacy#<n>` twin. Carrying a mention there would flip
 *     {@link resolveSessionPrAdmissionIdentity} from "unadjudicated → KEEP" to
 *     "adjudicated, not authored → REJECT" for a genuinely authored PR whose
 *     authoring link was capped out by the producer's own row caps or predates
 *     session→PR link extraction — exactly the compatibility keep that gate
 *     documents as "absent evidence is incomplete, not exculpatory". The
 *     mention still reaches the cloud as a `pull_request` artifactRef, so the
 *     link is not lost; only the adjudicating carrier declines to speak for it.
 */
export const PROSE_MENTION_REF_METHODS: ReadonlySet<string> = new Set<string>([
  ArtifactRefMethod.PrMentionInProse,
  ArtifactRefMethod.BranchMentionInProse,
]);

export const ArtifactRefTargetKind = {
  ClosedloopArtifact: "closedloop_artifact",
  PullRequest: "pull_request",
  Branch: "branch",
  Commit: "commit",
} as const;
export type ArtifactRefTargetKind =
  (typeof ArtifactRefTargetKind)[keyof typeof ArtifactRefTargetKind];

export const ArtifactRefRelation = {
  Input: "input",
  Output: "output",
  Referenced: "referenced",
  Created: "created",
  // FEA-3585: the session reviewed this artifact (currently PR-only — a
  // `gh pr view/diff/review <n>` on a specific PR). Distinct from `referenced`
  // (a passive prose/URL mention) so a review session is attributed to the PR it
  // actually operated on with a review-oriented state, not an authoring one.
  Reviewed: "reviewed",
  Workspace: "workspace",
} as const;
export type ArtifactRefRelation =
  (typeof ArtifactRefRelation)[keyof typeof ArtifactRefRelation];

/**
 * Canonical branch-lifecycle relation map for active writes. Session role
 * classification consumes this same predicate so the FEA-3752 membership/context
 * role stays aligned with FEA-3802 phase attribution semantics.
 */
export function isLifecycleBranchWriteRelation(
  relation: ArtifactRefRelation | null | undefined
): boolean {
  return (
    relation === ArtifactRefRelation.Created ||
    relation === ArtifactRefRelation.Output
  );
}

/**
 * Canonical branch-lifecycle relation map for read-only/context evidence.
 * These relations may affect whole-session membership, but must not create
 * Review/Rework lifecycle phase attribution on their own.
 */
export function isLifecycleBranchReadOnlyRelation(
  relation: ArtifactRefRelation | null | undefined
): boolean {
  return (
    relation === ArtifactRefRelation.Input ||
    relation === ArtifactRefRelation.Referenced ||
    relation === ArtifactRefRelation.Reviewed ||
    relation === ArtifactRefRelation.Workspace
  );
}

export const ArtifactRefConfidence = {
  HarnessRecord: "harness_record",
  McpCall: "mcp_call",
  UrlMatch: "url_match",
  SlugMatchInProse: "slug_match_in_prose",
  SlugMatchInBranch: "slug_match_in_branch",
  // ISS-5764: a PR/branch NAME read out of prose, with no command, URL, MCP
  // call, or harness record behind it. Deliberately the two WEAKEST tiers in
  // the extractor's `CONFIDENCE_RANK` — a prose mention must never displace,
  // downgrade, or re-label evidence that the session actually ran the command.
  PrMentionInProse: "pr_mention_in_prose",
  BranchMentionInProse: "branch_mention_in_prose",
} as const;
export type ArtifactRefConfidence =
  (typeof ArtifactRefConfidence)[keyof typeof ArtifactRefConfidence];

// --- Zod validators for sync contract ---

// Family-gated with an unbounded digit run: capping the width would make the sync
// contract silently REJECT a legitimate link the day slug numbering crosses it.
// FEA-4137: the accepted prefix alphabet (incl. `ISS`, the canonical Issue
// prefix, alongside the `FEA` compat alias) is driven from the single
// REFERENCEABLE_SLUG_PREFIXES SSOT so the desktop extractor, branch parser, and
// this cloud sync-schema validator can never drift. Without `ISS` here, one
// `ISS-###` ref would fail this `.regex()` and reject the WHOLE Desktop sync
// batch before slug-links.ts could resolve it.
const CLOSEDLOOP_SLUG_RE = new RegExp(
  String.raw`^(${buildSlugPrefixAlternation()})-\d+$`
);

export const MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS = 50 as const;

const branchLifecycleBoundaryKindSchema = z
  .enum([
    BranchLifecycleBoundaryKind.SessionStart,
    BranchLifecycleBoundaryKind.BranchWrite,
    BranchLifecycleBoundaryKind.PrRaised,
    BranchLifecycleBoundaryKind.ReviewFeedback,
    BranchLifecycleBoundaryKind.ReadOnlyReference,
    BranchLifecycleBoundaryKind.UnknownEvidence,
    BranchLifecycleBoundaryKind.SessionEnd,
  ])
  .catch(BranchLifecycleBoundaryKind.UnknownEvidence);

export const syncedBranchLifecycleEventSchema = z.object({
  kind: branchLifecycleBoundaryKindSchema,
  observedAt: syncTimestampSchema.optional(),
  evidenceId: z.string().min(1).max(500).optional(),
});
export type SyncedBranchLifecycleEvent = z.infer<
  typeof syncedBranchLifecycleEventSchema
>;

const syncedBranchLifecycleEventsSchema = z
  .array(syncedBranchLifecycleEventSchema)
  .max(MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS);

const artifactRefRelationSchema = z.enum([
  ArtifactRefRelation.Input,
  ArtifactRefRelation.Output,
  ArtifactRefRelation.Referenced,
  ArtifactRefRelation.Created,
  ArtifactRefRelation.Reviewed,
  ArtifactRefRelation.Workspace,
]);

const branchParticipationKindSchema = z.enum([
  BranchParticipationKind.Wrote,
  BranchParticipationKind.Reviewed,
]);

const sessionPrRelationTypeSchema = z.enum([
  SessionPrRelationType.Created,
  SessionPrRelationType.Referenced,
  SessionPrRelationType.Reviewed,
]);

const persistedSessionPrRelationTypesSchema = z
  .array(z.unknown())
  .transform((values) =>
    values.flatMap((value) => {
      const parsed = sessionPrRelationTypeSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
  );

const persistedArtifactRefRelationSchema = z.preprocess((value) => {
  const parsed = artifactRefRelationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}, artifactRefRelationSchema.optional());

const persistedBranchParticipationKindSchema = z.preprocess((value) => {
  const parsed = branchParticipationKindSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}, branchParticipationKindSchema.optional());

/**
 * A ClosedLoop slug ref (PRD/FEA/PLN/…). This is the only kind older Desktop
 * builds emit, so a ref with no explicit `kind` is normalized to this shape by
 * `syncedArtifactRefSchema` below. `relation`/`observedAt` are carried when the
 * newer Desktop supplies them (FEA-2729) and are optional for backward compat.
 */
const closedloopArtifactRefSchema = z.object({
  kind: z.literal(ArtifactRefTargetKind.ClosedloopArtifact),
  slug: z.string().regex(CLOSEDLOOP_SLUG_RE).max(200),
  isPrimary: z.boolean(),
  method: z.string().min(1).max(200),
  relation: artifactRefRelationSchema.optional(),
  observedAt: syncTimestampSchema.optional(),
});

/**
 * A branch ref carrying the remote identity (`repositoryFullName` +
 * `branchName`) plus the detection `method`/`relation` and per-link
 * `observedAt`. The cloud resolves the BRANCH artifact by
 * `(organizationId, repositoryFullName, branchName)` and persists a
 * SESSION→BRANCH link (FEA-2729).
 */
const branchArtifactRefSchema = z.object({
  kind: z.literal(ArtifactRefTargetKind.Branch),
  repositoryFullName: z.string().min(1).max(200),
  branchName: z.string().min(1).max(300),
  method: z.string().min(1).max(200),
  relation: artifactRefRelationSchema,
  branchParticipation: persistedBranchParticipationKindSchema,
  observedAt: syncTimestampSchema.optional(),
  branchLifecycleEvents: syncedBranchLifecycleEventsSchema.optional(),
  monitoredSessionActivity: syncedMonitoredSessionActivitySchema.optional(),
  /** Internal transport-only target that must not create generic Session links. */
  monitoredActivityOnly: z.literal(true).optional(),
});

/**
 * Branch-ref `method` values that constitute PUSH evidence — the branch reached
 * its remote (FEA-2531 / PRD-510 FR2). C1 discipline: a failed `git_push` is
 * dropped by the desktop extractor before it becomes a ref, so a synced
 * push-method ref is verified by construction. Drives `firstPushedAt`/
 * `pushSource` on both the desktop LOCAL lane and the cloud session producer
 * (PLN-1099 Phase 2), and the FR12 display gate. SSOT — the desktop
 * `db-constants.ts` re-exports these instead of re-declaring them.
 */
export const BRANCH_PUSH_METHOD_VALUES = ["git_push", "gh_pr_create"] as const;
export const BRANCH_PUSH_METHODS: ReadonlySet<string> = new Set(
  BRANCH_PUSH_METHOD_VALUES
);

/**
 * A pull-request ref carrying the PR facts the cloud syncs into
 * `PullRequestDetail` (FEA-2732). Identity is `(repositoryFullName, prNumber)`;
 * the fact fields are OPTIONAL enrichment — the desktop fills whatever its `gh`
 * enrichment / `gh_pr_create` parses know, and the cloud upserts them
 * webhook-wins for App repos or as the sole source for non-App repos. The
 * session↔PR association stays DERIVED via the branch (SESSION→BRANCH link →
 * `BranchDetail.currentPullRequestDetailId`), so this ref persists no session→PR
 * join row; it drives the PR detail row (and, via a push-method ref, the branch
 * lifecycle). All fact fields are optional, so a cloud that predates the
 * FEA-2732 enrichment simply strips them (the ref itself has shipped since
 * FEA-2729).
 */
const pullRequestStateSchema = z.enum([
  GitHubPRState.Open,
  GitHubPRState.Merged,
  GitHubPRState.Closed,
]);

/** Postgres int4 max — the `PullRequestDetail` LOC columns are Prisma `Int`. */
export const PR_INT_MAX = 2_147_483_647;

const pullRequestArtifactRefSchema = z.object({
  kind: z.literal(ArtifactRefTargetKind.PullRequest),
  repositoryFullName: z.string().min(1).max(200),
  prNumber: z.number().int().positive(),
  method: z.string().min(1).max(200),
  relation: artifactRefRelationSchema,
  observedAt: syncTimestampSchema.optional(),
  // The PR's HEAD branch — the cloud nests `PullRequestDetail` under this
  // branch's D2 artifact `(organizationId, repositoryFullName, branchName)`.
  // Optional: absent from older parses, in which case the cloud defers the PR
  // until the branch is resolvable (same late-target tolerance as branch refs).
  branchName: z.string().min(1).max(300).optional(),
  // --- PR facts (FEA-2732), all optional enrichment; each maps to a
  // PullRequestDetail column the cloud upserts (webhook-wins / sole-source). ---
  title: z.string().max(1024).optional(),
  // No client-supplied URL: `htmlUrl` is derived server-side from the trusted
  // repo + number (mirroring the sibling `prUrl` anti-forgery pattern) so a
  // compromised producer cannot plant an arbitrary href.
  // Unknown/future states degrade to absent (optional enrichment) rather than
  // failing strict array validation and rejecting the whole sync batch.
  state: pullRequestStateSchema.optional().catch(undefined),
  isDraft: z.boolean().optional(),
  // Bounded to int4 so a corrupt/oversized count can't overflow the DB write.
  additions: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  deletions: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  changedFiles: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  mergedAt: syncTimestampSchema.optional(),
  closedAt: syncTimestampSchema.optional(),
  branchLifecycleEvents: syncedBranchLifecycleEventsSchema.optional(),
  monitoredSessionActivity: syncedMonitoredSessionActivitySchema.optional(),
  /** Internal transport-only target that must not create generic Session links. */
  monitoredActivityOnly: z.literal(true).optional(),
});

/**
 * Upper bound on a synced commit `message` (the git subject line). Shared SSOT:
 * the desktop truncates to this before emitting and the wire schema enforces the
 * same `.max()`, so one long subject can never reject the whole batch parse (cf.
 * MAX_SYNCED_ARTIFACT_REFS).
 */
export const MAX_SYNCED_COMMIT_MESSAGE_LENGTH = 2000 as const;

/**
 * A git commit sha as carried on the wire: 7–40 lowercase hex (an abbreviated or
 * full sha). Exported so the desktop emitter can pre-validate a locally-stored
 * sha against the exact rule the cloud enforces — a `commit` ref is a KNOWN kind,
 * so a malformed sha is strictly validated (not forward-compat-dropped) and would
 * fail the single batch parse, stalling sync for every session in the tick. The
 * lower bound mirrors the desktop extractor's own `length < 7` guard; hex-only
 * keeps the cloud's sha-prefix `LIKE` match free of pattern metacharacters. No
 * `g` flag, so `.test()` is stateless and safe to reuse.
 */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * A commit ref carried for FEA-2731's `CommitDetail` ingest (PRD-510 D7). The
 * desktop supplies the ABBREVIATED sha it parsed from the `[branch 1a2b3c4]`
 * git-commit summary line (7–40 lowercase hex), the observing `branchName`, and
 * the desktop-parsed commit subject / timestamp / LOC. The cloud resolves the
 * branch artifact by `(organizationId, repositoryFullName, branchName)` and
 * upserts a `CommitDetail` row keyed by `(organizationId, repositoryFullName,
 * sha)` — reconciling with the GitHub push webhook by git-style sha-prefix
 * match (the abbreviated sha is a unique prefix of the full sha within a repo)
 * and expanding the stored sha to the full 40-char form once the webhook lands.
 * GitHub is authoritative for author/dates/additions-deletions; the
 * desktop-parsed LOC fills only nulls (Phase 4 provenance merge).
 */
const commitArtifactRefSchema = z.object({
  kind: z.literal(ArtifactRefTargetKind.Commit),
  repositoryFullName: z.string().min(1).max(200),
  branchName: z.string().min(1).max(300),
  // 7–40 lowercase hex (see COMMIT_SHA_PATTERN for the shared rule / rationale).
  sha: z.string().regex(COMMIT_SHA_PATTERN, "invalid_commit_sha"),
  // Commit subject parsed from the git summary line (PRD-486). The desktop
  // truncates to this bound before emitting so one long message can never
  // reject the whole batch (see MAX_SYNCED_ARTIFACT_REFS rationale).
  message: z.string().max(MAX_SYNCED_COMMIT_MESSAGE_LENGTH).optional(),
  committedAt: syncTimestampSchema.optional(),
  // Bounded to int4 so a corrupt/oversized count can't overflow the DB write
  // (mirrors pullRequestArtifactRefSchema's additions/deletions/changedFiles).
  linesAdded: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  linesRemoved: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  filesChanged: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  method: z.string().min(1).max(200),
  relation: artifactRefRelationSchema,
  observedAt: syncTimestampSchema.optional(),
});

/**
 * Ref kinds this contract version understands. A ref whose `kind` is outside
 * this set is dropped at ingest (forward compat) rather than failing the whole
 * payload — see `desktop-agent-sessions-schema.ts`.
 */
export const KNOWN_ARTIFACT_REF_KINDS: ReadonlySet<string> = new Set([
  ArtifactRefTargetKind.ClosedloopArtifact,
  ArtifactRefTargetKind.Branch,
  ArtifactRefTargetKind.PullRequest,
  ArtifactRefTargetKind.Commit,
]);

/** True when `kind` is a ref kind the current sync contract can persist/forward. */
export function isKnownArtifactRefKind(kind: unknown): boolean {
  return typeof kind === "string" && KNOWN_ARTIFACT_REF_KINDS.has(kind);
}

/**
 * FEA-2711 / ISS-4448+4449: the CLOUD wire-schema validator cap on a session's
 * `artifactRefs` array (the shared non-`prRefs` channel: `closedloop_artifact`
 * doc/slug refs, `branch` refs, `pull_request` refs, and `commit` refs).
 *
 * ISS-4448+4449 raised this 100 → 500, mirroring the sibling
 * `MAX_SYNCED_SESSION_PR_REFS` (ISS-4445) receive-side raise. The old value of
 * 100 was a single shared budget: on a session with, say, 88 PR refs ahead of
 * 23 document refs, the desktop producer's slice dropped 11 real document links
 * before they ever reached the cloud, and `linkedArtifactsTotal` (a post-persist
 * count) then reported the survivors as complete — silent data loss.
 *
 * Cross-repo version-skew safety: raising the *validator* max is additive and
 * backward compatible — a payload that validated before (≤100 refs) still
 * validates against the higher `.max()`. Never reject an old ≤100 payload. The
 * desktop PRODUCER slice bound is the separate, deliberately lower
 * `MAX_SYNCED_ARTIFACT_REFS_PRODUCER` below — see it for why the two differ and
 * how per-kind sub-budgets stop one ref kind starving another.
 */
export const MAX_SYNCED_ARTIFACT_REFS = 500 as const;
/**
 * ISS-4448+4449: the DESKTOP PRODUCER cap — the bound the desktop slices the
 * combined non-commit `artifactRefs` (doc + branch + PR kinds) to BEFORE
 * emitting, with commit refs then filling any remaining budget. Intentionally
 * still 100, decoupled from the raised validator cap
 * (`MAX_SYNCED_ARTIFACT_REFS`, now 500) above.
 *
 * Why the producer stays at 100 while the validator rises to 500 (version-skew,
 * per AGENTS.md cross-repo rules, identical to `MAX_SYNCED_SESSION_PR_REFS`):
 *   - New desktop → OLD cloud: an old cloud still enforces `.max(100)`. If a new
 *     desktop sliced the total to 500 it could emit up to 500 refs, and the old
 *     server would reject the ENTIRE batch (up to 200 sessions) as
 *     `validation_failed` and dead-letter every session in it. Keeping the
 *     producer *total* at 100 means a new desktop never emits a payload an old
 *     cloud can't accept — the raise is purely receive-side and deploy-safe.
 *   - Old desktop → new cloud: unchanged (old desktop already slices to ≤100;
 *     the raised validator accepts it).
 *
 * The data loss ISS-4448+4449 closes is NOT the total bound but the
 * cross-kind STARVATION inside it: PR + branch + doc refs shared one 100-slot
 * budget with PRs ordered first, so a PR-heavy session starved its document
 * refs to zero. The producer now gives document (`closedloop_artifact`) refs a
 * guaranteed floor (`MIN_SYNCED_DOCUMENT_REFS_PRODUCER`) so they survive within
 * the 100-total budget even behind many PR refs. A later PR raises this producer
 * bound (and adds the chunked ref sync higher counts need) once the raised-cap
 * cloud is universally deployed.
 */
export const MAX_SYNCED_ARTIFACT_REFS_PRODUCER = 100 as const;
/**
 * ISS-4448+4449: within the `MAX_SYNCED_ARTIFACT_REFS_PRODUCER` (100) non-commit
 * budget, the number of slots GUARANTEED to `closedloop_artifact` (document /
 * slug) refs so a PR-heavy session cannot starve its document links to zero.
 * Document refs are load-bearing for the session-detail Linked-artifacts row;
 * PR refs already have their own dedicated `prRefs` channel, so reserving a
 * document floor here costs the (also-duplicated-in-`prRefs`) PR-kind refs
 * nothing they can't recover on the PR side.
 */
export const MIN_SYNCED_DOCUMENT_REFS_PRODUCER = 50 as const;
/**
 * ISS-4445 (PR1/4 of PLN-1536): the CLOUD wire-schema validator cap — raised
 * 100 → 500 so the server *accepts* a large session's real linked PRs instead of
 * rejecting the whole batch at ingest. This is the receive-side ceiling only;
 * the desktop PRODUCER slice bound is the separate, deliberately lower
 * `MAX_SYNCED_SESSION_PR_REFS_PRODUCER` below — see it for why the two differ.
 *
 * Cross-repo version-skew safety: raising the *validator* max is additive and
 * backward compatible — a payload that validated before (≤100 refs) still
 * validates against the higher `.max()`. Never reject an old ≤100 payload.
 *
 * A full chunked PR-ref sync (unbounded PR counts) is the deferred follow-up
 * (PLN-1536 later PRs); this constant raise is the smallest correct receive-side
 * fix.
 */
export const MAX_SYNCED_SESSION_PR_REFS = 500 as const;
/**
 * ISS-4445 (PR1/4 of PLN-1536): the DESKTOP PRODUCER cap — the bound the desktop
 * slices `prRefs` (and the derived legacy `prs`) to BEFORE emitting a sync
 * payload. Intentionally still 100 in PR1, decoupled from the raised validator
 * cap (`MAX_SYNCED_SESSION_PR_REFS`, now 500) above.
 *
 * Why the producer stays at 100 while the validator rises to 500 (version-skew,
 * per AGENTS.md cross-repo rules):
 *   - New desktop → OLD cloud: an old cloud still enforces `.max(100)`. If a new
 *     desktop sliced to 500 it would emit up to 500 refs, and the old server
 *     would reject the ENTIRE batch (up to 200 sessions) as `validation_failed`
 *     and the client would dead-letter every session in it after retries. Keeping
 *     the producer at 100 means a new desktop never emits a payload an old cloud
 *     can't accept — the raise is purely receive-side and deploy-order-safe.
 *   - Old desktop → new cloud: unchanged (old desktop already slices to ≤100; the
 *     raised validator accepts it).
 * A later PLN-1536 PR raises this producer bound (and adds the chunked/batched
 * PR-ref sync those higher counts require) only once the raised-cap cloud is
 * universally deployed, so no live client can talk to a cloud that still caps
 * at 100. Until then this stays 100 by design.
 */
export const MAX_SYNCED_SESSION_PR_REFS_PRODUCER = 100 as const;

/**
 * A session→artifact ref in the sync contract. Backward compatible: a ref with
 * no explicit `kind` is treated as a `closedloop_artifact` slug ref (the shape
 * older Desktop builds emit).
 */
export const syncedArtifactRefSchema = z.preprocess(
  (value) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !("kind" in (value as Record<string, unknown>))
    ) {
      return {
        ...(value as Record<string, unknown>),
        kind: ArtifactRefTargetKind.ClosedloopArtifact,
      };
    }
    return value;
  },
  z.discriminatedUnion("kind", [
    closedloopArtifactRefSchema,
    branchArtifactRefSchema,
    pullRequestArtifactRefSchema,
    commitArtifactRefSchema,
  ])
);
export type SyncedArtifactRef = z.infer<typeof syncedArtifactRefSchema>;
export type SyncedBranchArtifactRef = z.infer<typeof branchArtifactRefSchema>;
export type SyncedPullRequestArtifactRef = z.infer<
  typeof pullRequestArtifactRefSchema
>;
export type SyncedCommitArtifactRef = z.infer<typeof commitArtifactRefSchema>;

export const syncedSessionPrRefSchema = z.object({
  repositoryFullName: z.string().min(1).max(200),
  prNumber: z.number().int().positive(),
  // Accepted for backward compatibility but ignored — the server derives the
  // canonical prUrl from repositoryFullName + prNumber to prevent forgery.
  prUrl: z.string().url().max(200).optional(),
  relationType: sessionPrRelationTypeSchema,
  branchLifecycleEvents: syncedBranchLifecycleEventsSchema.optional(),
});
export type SyncedSessionPrRef = z.infer<typeof syncedSessionPrRefSchema>;

export const sessionPrLinkMetadataSchema = z
  .object({
    linkKind: z
      .enum([
        SessionArtifactLinkKind.SessionPr,
        SessionArtifactLinkKind.SessionBranch,
      ])
      .optional(),
    relationTypes: persistedSessionPrRelationTypesSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    method: z.string().min(1).max(200).optional(),
    relation: persistedArtifactRefRelationSchema,
    branchParticipation: persistedBranchParticipationKindSchema,
    branchLifecycleEvents: syncedBranchLifecycleEventsSchema.optional(),
  })
  .passthrough();
export type SessionPrLinkMetadata = z.infer<typeof sessionPrLinkMetadataSchema>;

/**
 * Parses existing session-PR link metadata without trusting arbitrary JSON.
 * Invalid, low-confidence, or incomplete metadata is deliberately mapped to
 * the unknown purpose by the derivation helper.
 */
export function parseSessionPrLinkMetadata(
  metadata: unknown
): SessionPrLinkMetadata | null {
  const parsed = sessionPrLinkMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

/**
 * Derive durable branch participation from branch-link evidence. Active branch
 * writes map to `wrote`; deliberate review-feedback evidence maps to
 * `reviewed`. Passive workspace/referenced context remains unknown so readers
 * do not over-classify a checkout or mention as review participation.
 */
export function deriveBranchParticipationFromEvidence(input: {
  relation?: ArtifactRefRelation | null;
  method?: string | null;
  branchLifecycleEvents?:
    | readonly Pick<SyncedBranchLifecycleEvent, "kind">[]
    | null;
}): BranchParticipationKind | undefined {
  if (isLifecycleBranchWriteRelation(input.relation)) {
    return BranchParticipationKind.Wrote;
  }
  if (
    input.method === ArtifactRefMethod.PrReviewFeedbackCommand ||
    input.relation === ArtifactRefRelation.Reviewed ||
    input.branchLifecycleEvents?.some(
      (event) => event.kind === BranchLifecycleBoundaryKind.ReviewFeedback
    )
  ) {
    return BranchParticipationKind.Reviewed;
  }
  return undefined;
}

/**
 * Read branch participation from persisted link metadata, preferring an explicit
 * scalar value when one exists and falling back to legacy relation/method/events
 * evidence for pre-column rows.
 */
export function deriveBranchParticipationFromMetadata(
  metadata: SessionPrLinkMetadata | null
): BranchParticipationKind | undefined {
  const explicit = normalizeBranchParticipationKind(
    metadata?.branchParticipation
  );
  if (explicit) {
    return explicit;
  }
  const relationTypes = metadata?.relationTypes ?? [];
  if (relationTypes.includes(SessionPrRelationType.Created)) {
    return BranchParticipationKind.Wrote;
  }
  if (relationTypes.includes(SessionPrRelationType.Reviewed)) {
    return BranchParticipationKind.Reviewed;
  }
  return deriveBranchParticipationFromEvidence({
    relation: metadata?.relation,
    method: metadata?.method,
    branchLifecycleEvents: metadata?.branchLifecycleEvents,
  });
}

/**
 * Derives a display-safe PR purpose from read-only link metadata. Signal
 * precedence: CREATED (Authored) > REVIEWED (Reviewed) > REFERENCED. A review is
 * a stronger, deliberate relationship than a bare mention but is NOT authoring
 * output (FEA-3585 / preserves FEA-3584's Authored gating). Low-confidence or
 * unknown relation evidence falls back safely.
 */
export function deriveSessionPrPurposeFromMetadata(
  metadata: SessionPrLinkMetadata | null
): SessionPrPurpose {
  if (
    !metadata ||
    (metadata.confidence !== undefined && metadata.confidence < 0.5)
  ) {
    return SessionPrPurpose.Unknown;
  }
  const relationTypes = metadata.relationTypes ?? [];
  if (relationTypes.includes(SessionPrRelationType.Created)) {
    return SessionPrPurpose.Authored;
  }
  if (relationTypes.includes(SessionPrRelationType.Reviewed)) {
    return SessionPrPurpose.Reviewed;
  }
  if (relationTypes.includes(SessionPrRelationType.Referenced)) {
    return SessionPrPurpose.Referenced;
  }
  return SessionPrPurpose.Unknown;
}

// --- Cloud attribution-join query DTO ---

export type ArtifactSessionUsageByModel = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};

export type ArtifactSessionUsageSummary = {
  artifactId: string;
  artifactSlug: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  byModel: ArtifactSessionUsageByModel[];
};

// --- Local SQLite attribution-join query result ---

export type LocalArtifactSessionUsage = {
  artifactSlug: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};

// ---------------------------------------------------------------------------
// ISS-4922 — the SHARED session→PR admission gate.
//
// One rule, both lanes. FEA-3584 (Authored) and FEA-3585 (Reviewed) taught the
// CLOUD projection that a PR belongs in a session's PR set only when the session
// AUTHORED it; ISS-4768 extended that to the desktop-reported legacy
// `pullRequests` blob. None of it ever reached the desktop LOCAL lane
// (`apps/desktop/src/main/session/local-session-pull-requests.ts`), which merges
// `prs` + `prRefs` with no authoring gate at all — so a session whose only PR
// evidence is Referenced/Reviewed reads "Pull requests: None" on web and still
// shows a pill on Local, and (via `prsCount`/`prsMerged`) can trip the FEA-3551
// abandoned→Completed rescue on Local only.
//
// The rule was duplicated-by-omission because the two lanes consume DIFFERENT
// shapes: `SourceLinkRecord` (a Prisma row with nested branch/PR details) on the
// cloud, `SyncedSessionPrRef` on the desktop. So the gate lives here, over a
// NORMALIZED evidence shape both lanes map into — neither lane owns a second
// copy of the predicate, and narrowing one without the other stops being
// possible.
// ---------------------------------------------------------------------------

/**
 * What one piece of evidence says about one PR identity.
 *
 * `Authored` — the session authored this PR (the desktop extractor's `CREATED`
 * relation: `git_push` / `gh_pr_create`, which derives to
 * {@link SessionPrPurpose.Authored}).
 *
 * `Adjudicated` — some evidence SPEAKS about this PR but does not call it
 * authoring: a `REFERENCED`/`REVIEWED` link, or a PR merely reachable from a
 * session→branch link the session got by checking the branch out. This is the
 * evidence that REJECTS an otherwise-unvouched record.
 */
export const SessionPrEvidenceKind = {
  Authored: "authored",
  Adjudicated: "adjudicated",
} as const;
export type SessionPrEvidenceKind =
  (typeof SessionPrEvidenceKind)[keyof typeof SessionPrEvidenceKind];

/** One normalized statement about one PR identity, from either lane. */
export type SessionPrEvidenceRecord = {
  repositoryFullName: string | null | undefined;
  prNumber: number | string;
  kind: SessionPrEvidenceKind;
};

/**
 * The accumulated evidence a session's own records provide, keyed by canonical
 * PR identity. All three sets are repo-scoped (`<repo>#<n>`) with the repo-less
 * `legacy#<n>` twin stored alongside; the two key spaces are namespaced so they
 * share a set without colliding.
 */
export type SessionPrEvidence = {
  adjudicatedIdentities: Set<string>;
  authoredIdentities: Set<string>;
  authoredLegacyIdentities: Set<string>;
};

/**
 * The canonical repo-scoped PR identity `<repo>#<n>`, or the repo-unknown
 * `legacy#<n>` twin when the source carries no repository.
 *
 * The repo side goes through {@link normalizeRepoFullName} (ISS-4768), not a
 * bare lowercase: a producer can hand us `acme/web.git` or `/acme/web/` for the
 * same repository as the stored `acme/web`, and keying on the raw string would
 * mint two identities for one PR — so a genuinely authored PR would fail to
 * match its own blob entry and be dropped by the gate below.
 */
export function sessionPrIdentityKey(
  repositoryFullName: string | null | undefined,
  prNumber: number | string
): string {
  const trimmedRepository = repositoryFullName?.trim();
  const normalizedRepository = trimmedRepository
    ? normalizeRepoFullName(trimmedRepository)
    : null;
  const normalizedNumber = String(prNumber).trim();
  return normalizedRepository
    ? `${normalizedRepository}#${normalizedNumber}`
    : `legacy#${normalizedNumber}`;
}

/** Fold normalized evidence records into the identity sets the gate consults. */
export function collectSessionPrEvidence(
  records: Iterable<SessionPrEvidenceRecord>
): SessionPrEvidence {
  const evidence: SessionPrEvidence = {
    adjudicatedIdentities: new Set<string>(),
    authoredIdentities: new Set<string>(),
    authoredLegacyIdentities: new Set<string>(),
  };
  for (const record of records) {
    const identity = sessionPrIdentityKey(
      record.repositoryFullName,
      record.prNumber
    );
    const legacyIdentity = sessionPrIdentityKey(null, record.prNumber);
    if (record.kind === SessionPrEvidenceKind.Authored) {
      evidence.authoredIdentities.add(identity);
      evidence.authoredLegacyIdentities.add(legacyIdentity);
      continue;
    }
    evidence.adjudicatedIdentities.add(identity);
    evidence.adjudicatedIdentities.add(legacyIdentity);
  }
  return evidence;
}

/**
 * THE gate. Returns the identity a candidate PR record should be admitted at, or
 * null to reject it.
 *
 * COMPATIBILITY / INCOMPLETE EVIDENCE (do not narrow without approval): this is
 * PER PR, never a per-session switch. It rejects only an identity the session's
 * own evidence ADJUDICATED and did not call authoring. A PR no evidence speaks
 * about is unadjudicated — which happens for a stored row predating session→PR
 * link extraction, for a version-skewed partial row, and for a real authored PR
 * whose link was capped out by the desktop producer's independent 100-row caps
 * on the blob and on `prRefs` — so it is KEPT. Absent evidence is incomplete,
 * not exculpatory; suppression requires evidence that actually looked at this PR
 * and classified it as something other than authoring. Graceful degradation,
 * never silent deletion.
 *
 *   1. authored at the record's own repo → that repo-scoped identity.
 *   2. the record carries NO repo and the number is authored by some evidence →
 *      the repo-less `legacy#<n>` twin, the documented legacy fallback.
 *   3. adjudicated but not authored → null. The phantom.
 *   4. unadjudicated → the record's identity (the compatibility keep above).
 *
 * ADMISSION is repo-scoped while ADJUDICATION also consults `legacy#<n>`, and the
 * asymmetry is deliberate. A repo-less record's `#42` is indistinguishable from
 * `A#42` and from a genuinely repo-less `#42`. Consulting `legacy#<n>` to REJECT
 * is conservative — some evidence looked at a `#42` relationship and did not call
 * it authoring. Consulting it to ADMIT would fold repo A's record onto repo B's
 * authored `#42`, i.e. fabricate an attribution from an ambiguous match.
 */
export function resolveSessionPrAdmissionIdentity(
  record: {
    repositoryFullName: string | null | undefined;
    prNumber: number | string;
  },
  evidence: SessionPrEvidence
): string | null {
  const recordIdentity = sessionPrIdentityKey(
    record.repositoryFullName,
    record.prNumber
  );
  if (evidence.authoredIdentities.has(recordIdentity)) {
    return recordIdentity;
  }
  const legacyIdentity = sessionPrIdentityKey(null, record.prNumber);
  const recordIsRepoLess = recordIdentity === legacyIdentity;
  if (
    recordIsRepoLess &&
    evidence.authoredLegacyIdentities.has(legacyIdentity)
  ) {
    return recordIdentity;
  }
  if (
    evidence.adjudicatedIdentities.has(recordIdentity) ||
    evidence.adjudicatedIdentities.has(legacyIdentity)
  ) {
    return null;
  }
  return recordIdentity;
}

/**
 * The evidence a desktop-local session's artifact-link PR refs provide. A
 * `CREATED` ref is the desktop extractor's authoring signal (`git_push` /
 * `gh_pr_create`); `REFERENCED`/`REVIEWED` are mentions and reviews, which
 * adjudicate the identity without vouching for it. This is the desktop half of
 * the same mapping the cloud performs over `SourceLinkRecord` purposes, so the
 * two lanes feed ONE gate rather than two predicates.
 */
export function toSessionPrEvidenceRecords(
  refs: readonly SyncedSessionPrRef[]
): SessionPrEvidenceRecord[] {
  return refs.map((ref) => ({
    kind:
      ref.relationType === SessionPrRelationType.Created
        ? SessionPrEvidenceKind.Authored
        : SessionPrEvidenceKind.Adjudicated,
    prNumber: ref.prNumber,
    repositoryFullName: ref.repositoryFullName,
  }));
}

/**
 * The semantic ROLE values a session→document link carries. The cloud persists
 * the winning value into the ArtifactLink metadata that the cloud session
 * projection reads back onto `SessionLinkedArtifact.role`, and the desktop-local
 * projection (ISS-5617) derives the same value for a session it renders without
 * a round trip — so the two producers describe one link the same way.
 */
export const SessionArtifactLinkRole = {
  Input: "input",
  Referenced: "referenced",
  Workspace: "workspace",
} as const;
export type SessionArtifactLinkRole =
  (typeof SessionArtifactLinkRole)[keyof typeof SessionArtifactLinkRole];

/** Role precedence for merging duplicate artifact refs: input > referenced > workspace. */
const ARTIFACT_ROLE_PRECEDENCE: Record<string, number> = {
  [SessionArtifactLinkRole.Input]: 0,
  [SessionArtifactLinkRole.Referenced]: 1,
  [SessionArtifactLinkRole.Workspace]: 2,
};

/**
 * Derive a semantic role from the extraction method. The sync contract's
 * `relation` field is optional (older Desktop builds omit it), so the role is
 * reconstructed from the `method` string, which is always present.
 *
 * Lives here rather than in the cloud ingest lane that used to own it because
 * BOTH producers of `SessionLinkedArtifact.role` need it: the cloud ingest
 * (`apps/api/.../artifact-links/slug-links.ts`, which persists the derived role)
 * and the desktop-local session-detail projection (ISS-5617, which derives it
 * in-process for a session it never synced). A second copy is exactly how the
 * two surfaces would come to disagree about one link.
 */
export function roleFromMethod(
  method: string,
  isPrimary: boolean
): SessionArtifactLinkRole {
  if (isPrimary) {
    return SessionArtifactLinkRole.Input;
  }
  switch (method) {
    case ArtifactRefMethod.McpToolCall:
    case ArtifactRefMethod.LaunchMetadata:
      return SessionArtifactLinkRole.Input;
    case ArtifactRefMethod.SlugInBranch:
    case ArtifactRefMethod.SlugInCwd:
    case ArtifactRefMethod.SlugInSessionSlug:
      return SessionArtifactLinkRole.Workspace;
    default:
      return SessionArtifactLinkRole.Referenced;
  }
}

/**
 * Whether `candidate` outranks `existing` when two refs resolve to the same
 * artifact and their roles disagree. An unknown role sorts last, so a value this
 * module does not know about never displaces one it does.
 */
export function isHigherPrecedenceArtifactRole(
  candidate: string,
  existing: string
): boolean {
  return (
    (ARTIFACT_ROLE_PRECEDENCE[candidate] ?? 99) <
    (ARTIFACT_ROLE_PRECEDENCE[existing] ?? 99)
  );
}
