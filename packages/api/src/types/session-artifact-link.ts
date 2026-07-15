import { z } from "zod";
import { GitHubPRState } from "./github-status";

// --- Const-object enums (no `enum` keyword per codebase conventions) ---

export const SessionPrRelationType = {
  Created: "CREATED",
  Referenced: "REFERENCED",
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
  Referenced: "referenced",
  Unknown: "unknown",
} as const;
export type SessionPrPurpose =
  (typeof SessionPrPurpose)[keyof typeof SessionPrPurpose];

export const SESSION_PR_PURPOSE_LABELS: Record<SessionPrPurpose, string> = {
  [SessionPrPurpose.Authored]: "Authored PR",
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
  LaunchMetadata: "launch_metadata",
  GitCommand: "git_command",
} as const;
export type ArtifactRefMethod =
  (typeof ArtifactRefMethod)[keyof typeof ArtifactRefMethod];

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
  Workspace: "workspace",
} as const;
export type ArtifactRefRelation =
  (typeof ArtifactRefRelation)[keyof typeof ArtifactRefRelation];

export const ArtifactRefConfidence = {
  McpCall: "mcp_call",
  UrlMatch: "url_match",
  SlugMatchInProse: "slug_match_in_prose",
  SlugMatchInBranch: "slug_match_in_branch",
} as const;
export type ArtifactRefConfidence =
  (typeof ArtifactRefConfidence)[keyof typeof ArtifactRefConfidence];

// --- Zod validators for sync contract ---

const CLOSEDLOOP_SLUG_RE = /^(PRD|FEA|PLN|PRO|WRK|SES)-\d{1,5}$/;

/**
 * ISO-8601 timestamp accepted by the sync contract. Mirrors the cloud-side
 * `isoDateSchema` (trim + `Date.parse`) without importing the apps/api-only
 * module — this package must stay client-safe.
 */
const isoTimestampSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value.length > 0 && Number.isFinite(Date.parse(value)),
    "invalid_date"
  );

const artifactRefRelationSchema = z.enum([
  ArtifactRefRelation.Input,
  ArtifactRefRelation.Output,
  ArtifactRefRelation.Referenced,
  ArtifactRefRelation.Created,
  ArtifactRefRelation.Workspace,
]);

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
  observedAt: isoTimestampSchema.optional(),
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
  observedAt: isoTimestampSchema.optional(),
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
  observedAt: isoTimestampSchema.optional(),
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
  mergedAt: isoTimestampSchema.optional(),
  closedAt: isoTimestampSchema.optional(),
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
  committedAt: isoTimestampSchema.optional(),
  // Bounded to int4 so a corrupt/oversized count can't overflow the DB write
  // (mirrors pullRequestArtifactRefSchema's additions/deletions/changedFiles).
  linesAdded: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  linesRemoved: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  filesChanged: z.number().int().nonnegative().max(PR_INT_MAX).optional(),
  method: z.string().min(1).max(200),
  relation: artifactRefRelationSchema,
  observedAt: isoTimestampSchema.optional(),
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
 * FEA-2711: per-session upper bound on synced `artifactRefs` / `prRefs`. The
 * single source of truth shared by both sync sides — the desktop slices each
 * array to its cap before emitting, and the cloud wire schema enforces the same
 * `.max()` — so the two can never drift. This matters because the cloud
 * validates the whole batch (up to 200 sessions) with a single parse: one
 * session over the cap would otherwise reject the entire batch and stall sync,
 * not just truncate that session.
 */
export const MAX_SYNCED_ARTIFACT_REFS = 100 as const;
export const MAX_SYNCED_SESSION_PR_REFS = 100 as const;

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
export type SyncedClosedloopArtifactRef = z.infer<
  typeof closedloopArtifactRefSchema
>;
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
  relationType: z.enum([
    SessionPrRelationType.Created,
    SessionPrRelationType.Referenced,
  ]),
});
export type SyncedSessionPrRef = z.infer<typeof syncedSessionPrRefSchema>;

export const sessionPrLinkMetadataSchema = z
  .object({
    linkKind: z.literal(SessionArtifactLinkKind.SessionPr).optional(),
    relationTypes: z
      .array(
        z.enum([
          SessionPrRelationType.Created,
          SessionPrRelationType.Referenced,
        ])
      )
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
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
 * Derives a display-safe PR purpose from read-only link metadata. CREATED is
 * the strongest supported signal; REFERENCED is used only when authoring was
 * not observed. Low-confidence or unknown relation evidence falls back safely.
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
