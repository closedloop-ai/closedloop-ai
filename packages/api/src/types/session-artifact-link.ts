import { POSTGRES_INT4_MAX } from "@closedloop-ai/loops-api/column-limits";
import { z } from "zod";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
  normalizeBranchParticipationKind,
} from "./branch.ts";
import { Priority } from "./common.ts";
import { GitHubPRState } from "./github-status.ts";
import { isPriority } from "./priority-contract.ts";
import { syncedMonitoredSessionActivitySchema } from "./session-monitored-activity.ts";
import {
  allowsUniqueBranchPrFallback as allowsUniqueBranchPrFallbackContract,
  classifySessionPrMetadata as classifySessionPrMetadataContract,
  deriveSessionPrPurposeFromRelationTypes as deriveSessionPrPurposeFromRelationTypesContract,
  hasSessionPrLinkKind as hasSessionPrLinkKindContract,
  type PersistedSessionPrRef as PersistedSessionPrRefContract,
  type SessionArtifactLinkKind as SessionArtifactLinkKindContract,
  type SessionPrMetadataClassification as SessionPrMetadataClassificationContract,
  type SessionPrPurpose as SessionPrPurposeContract,
  type SessionPrRelationType as SessionPrRelationTypeContract,
  SessionArtifactLinkKind as sessionArtifactLinkKindContract,
  sessionPrIdentityKey as sessionPrIdentityKeyContract,
  sessionPrIdentityMetadataSchema,
  SessionPrMetadataClassificationKind as sessionPrMetadataClassificationKindContract,
  SessionPrPurpose as sessionPrPurposeContract,
  SESSION_PR_PURPOSE_LABELS as sessionPrPurposeLabelsContract,
  sessionPrRefsFromMetadata as sessionPrRefsFromMetadataContract,
  SessionPrRelationType as sessionPrRelationTypeContract,
  sessionPrRelationTypeSchema,
} from "./session-pr-link-metadata.ts";
import { buildSlugPrefixAlternation } from "./slug-prefix.ts";
import { storableSyncTimestampSchema } from "./sync-timestamp.ts";

/**
 * Wire bound on `repositoryFullName` across every ref schema below. The desktop
 * emitter (`sync-source.ts`) reads the same constant so a stored slug past it is
 * dropped before the batch, never rejected by it (ISS-8882).
 */
export const REPOSITORY_FULL_NAME_MAX_LENGTH = 200;
/** Wire bound on the ignored `prUrl`; the producer clamps to it (ISS-8882). */
export const SYNCED_PR_URL_MAX_LENGTH = 200;

export const allowsUniqueBranchPrFallback =
  allowsUniqueBranchPrFallbackContract;
export const classifySessionPrMetadata = classifySessionPrMetadataContract;
export const deriveSessionPrPurposeFromRelationTypes =
  deriveSessionPrPurposeFromRelationTypesContract;
export const hasSessionPrLinkKind = hasSessionPrLinkKindContract;
export type PersistedSessionPrRef = PersistedSessionPrRefContract;
export const SESSION_PR_PURPOSE_LABELS = sessionPrPurposeLabelsContract;
export const SessionArtifactLinkKind = sessionArtifactLinkKindContract;
export type SessionArtifactLinkKind = SessionArtifactLinkKindContract;
export const sessionPrIdentityKey = sessionPrIdentityKeyContract;
export type SessionPrMetadataClassification =
  SessionPrMetadataClassificationContract;
export const SessionPrMetadataClassificationKind =
  sessionPrMetadataClassificationKindContract;
export const SessionPrPurpose = sessionPrPurposeContract;
export type SessionPrPurpose = SessionPrPurposeContract;
export const SessionPrRelationType = sessionPrRelationTypeContract;
export type SessionPrRelationType = SessionPrRelationTypeContract;
export const sessionPrRefsFromMetadata = sessionPrRefsFromMetadataContract;

// --- Const-object enums (no `enum` keyword per codebase conventions) ---

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
 * weakest evidence any ref can carry. Consumers treat them specially where
 * admitting a mention as ordinary repository or PR evidence would overstate
 * what the session actually worked on:
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
 *  3. **Observed-repository discovery** ignores them, so a dependency or fixture
 *     PR named in transcript prose does not become evidence that the org works
 *     in that repository.
 */
export const PROSE_MENTION_REF_METHODS: ReadonlySet<string> = new Set<string>([
  ArtifactRefMethod.PrMentionInProse,
  ArtifactRefMethod.BranchMentionInProse,
]);

/**
 * ISS-5823: is this persisted PR identity backed only by a prose mention?
 *
 * A row written before ISS-5823 carries no `method`, and every such row came
 * from the command-derived `prRefs` carrier — so an absent method is NOT
 * "unknown, treat as weak", it is a positive statement that the identity is not
 * prose-derived. Reading it the other way would retroactively evict every
 * historical PR from the metric populations this discriminator gates.
 */
export function isProseDerivedSessionPrRef(
  ref: Pick<PersistedSessionPrRef, "method">
): boolean {
  return ref.method !== undefined && PROSE_MENTION_REF_METHODS.has(ref.method);
}

/**
 * The identities a link declares on evidence STRONGER than a prose mention.
 *
 * The sibling of {@link sessionPrRefsFromMetadata}, and the one every metric- or
 * cost-bearing reader must use: a link that mixes a command-derived ref with a
 * prose one keeps the strong `linkKind`, so the link-level predicate alone
 * cannot separate them and the per-ref discriminator is what does.
 */
export function commandDerivedSessionPrRefsFromMetadata(
  metadata: unknown
): PersistedSessionPrRef[] {
  return sessionPrRefsFromMetadata(metadata).filter(
    (ref) => !isProseDerivedSessionPrRef(ref)
  );
}

/**
 * True when EVERY identity this link declares is prose-derived — the link-level
 * twin of {@link isProseDerivedSessionPrRef}, derived from the refs rather than
 * read off `linkKind` so the two gates cannot disagree. A link declaring no
 * identity at all is not prose-derived (it is the legacy unique-branch shape).
 */
export function isProseDerivedSessionPrLink(metadata: unknown): boolean {
  const refs = sessionPrRefsFromMetadata(metadata);
  return refs.length > 0 && refs.every(isProseDerivedSessionPrRef);
}

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
  observedAt: storableSyncTimestampSchema.optional(),
  evidenceId: z.string().min(1).optional(),
});
export type SyncedBranchLifecycleEvent = z.infer<
  typeof syncedBranchLifecycleEventSchema
>;

// ISS-8070: unbounded — these live in `artifact_links.metadata` (jsonb) and key
// no index, so the bound only cost the whole batch parse.
// ISS-8247 removed the cloud-side newest-N merge window that used to clip this
// accepted set back to `MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS` in
// `artifact-links/shared.ts`, so the stored set is now the accepted set. That
// constant's ONLY remaining consumer is the desktop envelope validity predicate
// in `apps/desktop/src/main/database/branch-activity-sql.ts`, which classifies
// an over-count carrier as an invalid envelope and degrades that branch's local
// activity evidence to `Partial` — it NAMES the degradation rather than
// acknowledging a store it did not make, so it is deliberately left in place.
const syncedBranchLifecycleEventsSchema = z.array(
  syncedBranchLifecycleEventSchema
);

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

// Membership tests, not `safeParse`: a failed parse builds a `ZodError` for
// every absent field, and that dominated the per-link parse cost of every
// session-link reader (ISS-11895).
const artifactRefRelations = new Set<unknown>(
  artifactRefRelationSchema.options
);
const branchParticipationKinds = new Set<unknown>(
  branchParticipationKindSchema.options
);

export const persistedArtifactRefRelationSchema = z.preprocess(
  (value) => (artifactRefRelations.has(value) ? value : undefined),
  artifactRefRelationSchema.optional()
);

const persistedBranchParticipationKindSchema = z.preprocess(
  (value) => (branchParticipationKinds.has(value) ? value : undefined),
  branchParticipationKindSchema.optional()
);

/**
 * ISS-10332: a desktop-set priority on the sync payload (a session, or a branch
 * ref). A value this contract does not know — a newer desktop's member, a
 * `null`, anything else — degrades to ABSENT rather than failing the batch: the
 * whole sync batch is one `safeParse`, and an absent priority is "no claim",
 * which the cloud already tolerates.
 */
export const syncedPrioritySchema = z.preprocess(
  (value) => (isPriority(value) ? value : undefined),
  z.enum(Priority).optional()
);

/**
 * A ClosedLoop slug ref (PRD/FEA/PLN/…). This is the only kind older Desktop
 * builds emit, so a ref with no explicit `kind` is normalized to this shape by
 * `syncedArtifactRefSchema` below. `relation`/`observedAt` are carried when the
 * newer Desktop supplies them (FEA-2729) and are optional for backward compat.
 */
const closedloopArtifactRefSchema = z.object({
  kind: z.literal(ArtifactRefTargetKind.ClosedloopArtifact),
  // ISS-8069 owns `slug`: it resolves `artifacts.slug`, keyed by
  // @@unique([organizationId, slug]). Dropping the bound before that index is
  // safe would trade a legible 400 for a poison batch retried forever.
  slug: z.string().regex(CLOSEDLOOP_SLUG_RE).max(200),
  isPrimary: z.boolean(),
  // ISS-8070: `method` lands only in `artifact_links.metadata` (jsonb).
  method: z.string().min(1),
  relation: artifactRefRelationSchema.optional(),
  observedAt: storableSyncTimestampSchema.optional(),
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
  // ISS-8069 owns this pair: `ensureBranchArtifactRow` writes both into
  // `branch_details`, keyed by
  // @@unique([organizationId, repositoryFullName, branchName]).
  repositoryFullName: z.string().min(1).max(REPOSITORY_FULL_NAME_MAX_LENGTH),
  branchName: z.string().min(1).max(300),
  // ISS-8070: the one column-backed `method`. It lands in
  // `artifact_links.branch_participation_method`, widened VARCHAR(200) → TEXT
  // by the accompanying migration; that column keys no index.
  method: z.string().min(1),
  relation: artifactRefRelationSchema,
  branchParticipation: persistedBranchParticipationKindSchema,
  // ISS-10332: seeds the cloud branch's priority only while it holds none;
  // omitted by an older desktop and whenever the desktop holds none.
  priority: syncedPrioritySchema,
  observedAt: storableSyncTimestampSchema.optional(),
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

/**
 * Postgres int4 max — `PullRequestDetail.number` and LOC columns are Prisma `Int`.
 *
 * Derived rather than restated: ISS-8564 needed the same ceiling in
 * `@closedloop-ai/loops-api`, which cannot import this package without a cycle, so the
 * literal lives there and this keeps the PR-domain name its callers use.
 */
export const PR_INT_MAX = POSTGRES_INT4_MAX;

const PR_NUMBER_DECIMAL_RE = /^\d+$/;
const prNumberSchema = z.number().int().positive().max(PR_INT_MAX);

const pullRequestArtifactRefSchema = z.object({
  kind: z.literal(ArtifactRefTargetKind.PullRequest),
  // ISS-8069 owns this: the PR lane resolves its branch through the same
  // `ensureBranchArtifactRow`, so the value reaches the `branch_details` unique
  // index even though `pull_request_details.repository_full_name` is TEXT.
  repositoryFullName: z.string().min(1).max(REPOSITORY_FULL_NAME_MAX_LENGTH),
  prNumber: prNumberSchema,
  // ISS-8070: `method` lands only in `artifact_links.metadata` (jsonb).
  method: z.string().min(1),
  relation: artifactRefRelationSchema,
  observedAt: storableSyncTimestampSchema.optional(),
  // The PR's HEAD branch — the cloud nests `PullRequestDetail` under this
  // branch's D2 artifact `(organizationId, repositoryFullName, branchName)`.
  // Optional: absent from older parses, in which case the cloud defers the PR
  // until the branch is resolvable (same late-target tolerance as branch refs).
  // ISS-8069 owns this too — same `branch_details` unique index as above.
  branchName: z.string().min(1).max(300).optional(),
  // ISS-8175: the PR's BASE ref as `gh` named it when the desktop OPENED this
  // PR. Distinct evidence from a webhook's base (current at read time): this one
  // is read once, locally, and can be stale by the time it syncs — hence its own
  // `BranchBaseBranchSource.DesktopPullRequestBase`, ranked below HarnessInput.
  // Optional and omission-preserving in both directions: an installed desktop
  // that predates this field simply never sends it, and the cloud read then
  // serves the same honest unknown it serves today (ISS-8155). Only a PR the
  // desktop OPENED can originate one; it then rides that PR's artifact row, so a
  // later session referencing the SAME PR carries the value this machine already
  // read. A PR no session here created never gets one.
  //
  // `.catch(undefined)` for the same reason `state` below carries it: this whole
  // batch is one `safeParse`, so a bound that REJECTS would 400 up to 200
  // sessions on one bad value and keep 400ing them on every retry. The column is
  // unbounded TEXT with no index, so nothing downstream holds a premise the
  // `.max()` guarantees — degrade to absent, never reject.
  //
  // `.trim()` BEFORE `.min(1)` so a whitespace-only value takes that same absent
  // path rather than becoming a branch base no git ref can ever match: this
  // value outranks `McpInput`, so a blank one would pin the branch until a
  // higher-priority source arrived.
  baseRef: z.string().trim().min(1).max(300).optional().catch(undefined),
  // --- PR facts (FEA-2732), all optional enrichment; each maps to a
  // PullRequestDetail column the cloud upserts (webhook-wins / sole-source). ---
  // ISS-8070: `pull_request_details.title` is unindexed TEXT, so unbounded.
  title: z.string().optional(),
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
  // `storable…`, not the bare `syncTimestampSchema`, because these two reach a
  // Postgres `timestamp`: an instant the column cannot hold degrades to absent
  // instead of rejecting, for the reason `baseRef` and `state` above carry
  // `.catch(undefined)` — the batch is one `safeParse`, so rejecting would 400
  // up to 200 sessions on one bad date. Both write sites branch on
  // `!== undefined`. Full rationale on the schema itself.
  mergedAt: storableSyncTimestampSchema.optional(),
  closedAt: storableSyncTimestampSchema.optional(),
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
  repositoryFullName: z.string().min(1).max(REPOSITORY_FULL_NAME_MAX_LENGTH),
  branchName: z.string().min(1).max(300),
  // 7–40 lowercase hex (see COMMIT_SHA_PATTERN for the shared rule / rationale).
  sha: z.string().regex(COMMIT_SHA_PATTERN, "invalid_commit_sha"),
  // Commit subject parsed from the git summary line (PRD-486). The desktop
  // truncates to this bound before emitting so one long message can never
  // reject the whole batch (see MAX_SYNCED_ARTIFACT_REFS rationale).
  message: z.string().max(MAX_SYNCED_COMMIT_MESSAGE_LENGTH).optional(),
  committedAt: storableSyncTimestampSchema.optional(),
  // Bounded to int4 so a corrupt/oversized count can't overflow the DB write
  // (mirrors pullRequestArtifactRefSchema's additions/deletions/changedFiles).
  linesAdded: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  linesRemoved: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  filesChanged: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  method: z.string().min(1).max(200),
  relation: artifactRefRelationSchema,
  observedAt: storableSyncTimestampSchema.optional(),
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
 * FEA-2711 / ISS-4448+4449: the historical CLOUD wire-schema validator cap on a
 * session's `artifactRefs` array (the shared non-`prRefs` channel:
 * `closedloop_artifact` doc/slug refs, `branch` refs, `pull_request` refs, and
 * `commit` refs).
 *
 * ISS-8051 REMOVED that `.max()`: the cloud no longer rejects an over-cap
 * `artifactRefs` array, so nothing on the receive side enforces this number any
 * more. It survives as a producer-side reference bound — notably the desktop's
 * `SESSION_DOCUMENT_LINK_SCAN_LIMIT` — and the raise narrative below is kept
 * because it explains the value, not because the validator still applies it.
 *
 * ISS-4448+4449 raised this 100 → 500, mirroring the receive-side raise the
 * synced PR-ref channel got at the same time (ISS-4445; that channel's bounds
 * were since removed outright by ISS-8051 and ISS-9859). The old value of
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
 * per AGENTS.md cross-repo rules). This is a SEPARATE bound from the synced
 * PR-ref channel, which no longer has one — do not conflate the two:
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
  repositoryFullName: z.string().min(1).max(REPOSITORY_FULL_NAME_MAX_LENGTH),
  prNumber: prNumberSchema,
  // Accepted for backward compatibility but ignored — the server derives the
  // canonical prUrl from repositoryFullName + prNumber to prevent forgery.
  // `.catch(undefined)` because the batch is one `safeParse` (see `baseRef`):
  // an over-long or malformed value the server discards anyway must degrade to
  // absent, not 400 up to 200 sessions on every retry (ISS-8882).
  prUrl: z
    .string()
    .url()
    .max(SYNCED_PR_URL_MAX_LENGTH)
    .optional()
    .catch(undefined),
  relationType: sessionPrRelationTypeSchema,
  branchLifecycleEvents: syncedBranchLifecycleEventsSchema.optional(),
});
export type SyncedSessionPrRef = z.infer<typeof syncedSessionPrRefSchema>;

export const sessionPrLinkMetadataSchema = z
  .object({
    confidence: z.number().min(0).max(1).optional(),
    // ISS-8070: unbounded, and it MUST stay that way. This is a
    // PERSISTED-READ validator over `artifact_links.metadata` (jsonb), not a
    // wire guard: the branch writer already stored this `method`, so a bound
    // here rejects a value the ingest lane accepted. Because the parse is
    // whole-object, that failure returns `null` from
    // `parseSessionPrLinkMetadata` and takes every SIBLING field with it —
    // `branchLifecycleEvents`, `relation`, `branchParticipation` — for all six
    // consumers of the parser.
    method: z.string().min(1).optional(),
    relation: persistedArtifactRefRelationSchema,
    branchParticipation: persistedBranchParticipationKindSchema,
    branchLifecycleEvents: syncedBranchLifecycleEventsSchema.optional(),
  })
  .extend(sessionPrIdentityMetadataSchema.shape)
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
  return deriveSessionPrPurposeFromRelationTypes(
    metadata.relationTypes ?? [],
    metadata.confidence
  );
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

/** Valid pull request number domain for Prisma `Int` identity columns. */
export function isValidPullRequestNumber(prNumber: number): boolean {
  return Number.isInteger(prNumber) && prNumber > 0 && prNumber <= PR_INT_MAX;
}

/** Parse a canonical decimal PR number without JavaScript prefix coercion. */
export function parsePullRequestNumber(value: number | string): number | null {
  const prNumber =
    typeof value === "number" ? value : parseDecimalPullRequestNumber(value);
  return prNumber !== null && isValidPullRequestNumber(prNumber)
    ? prNumber
    : null;
}

function parseDecimalPullRequestNumber(value: string): number | null {
  if (!PR_NUMBER_DECIMAL_RE.test(value)) {
    return null;
  }
  return Number(value);
}
