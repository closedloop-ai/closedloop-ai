import { z } from "zod";
import type { ActivityBucket } from "./activity-bucket";
import type { AgentSessionCloudSyncState } from "./agent-session-cloud-sync-state-constants.js";
import type { AgentSessionCostSplitFields } from "./agent-session-cost-split";
import type {
  AgentSessionModelFacetOption,
  AgentSessionProjectFacetOption,
} from "./agent-session-facet-options";
import type { AgentSessionListPageInfo } from "./agent-session-list-contract.js";
import type { AcceptedAgentSessionSyncSchemaVersion } from "./agent-session-sync-schema-version.ts";
import type { ToolCallDetailState } from "./agent-session-tool-call.js";
import type {
  AgentSessionAgentRosterIncompleteness,
  AgentSessionAgentTypeBreakdown,
  AgentSessionProjectBreakdown,
  AgentSessionRepositoryBreakdown,
  AgentSessionToolBreakdown,
  AgentSessionUsageByBranch,
  AgentSessionUsageByPr,
} from "./agent-session-usage-breakdown";
import type { AgentSessionUsageComparison } from "./agent-session-usage-comparison";
import type { JsonObject, JsonValue, Priority } from "./common.js";
import type { CustomFieldValueDetail } from "./custom-field.js";
import type { DataSyncLevel } from "./data-sync-level.js";
import type { TranscriptAvailabilitySummary } from "./desktop-transcripts.js";
import { DesktopWriteLaneRejectReason } from "./desktop-write-lane.ts";
import type { DocumentType } from "./document.js";
import type { LocPerDollarCoverage } from "./loc-per-dollar-coverage.js";
import type { SessionOperationEvidence } from "./operation-claims.ts";
import type { ReadSource } from "./read-source.js";
import type {
  SessionActivityMetricsRead,
  SyncedSessionActivityMetrics,
  TranscriptArchiveProgress,
} from "./session-activity-metrics";
import type {
  SyncedArtifactRef,
  SyncedSessionPrRef,
} from "./session-artifact-link.js";
import type { SessionEvidenceCoverage } from "./session-evidence-coverage-constants.js";
import type {
  PhaseIterations,
  PhaseLoopback,
  SessionMarker,
  SessionPhase,
  SessionSpan,
  SessionThrottle,
} from "./session-trace-shape.ts";
import type { TurnItem } from "./session-transcript-turn.ts";
import type { SessionUntrackedRepositoryTarget } from "./session-untracked-repository.ts";
import type { SyncedComponentVariantsEnvelope } from "./synced-component-content.js";
import type {
  ArtifactTagAvailability,
  ArtifactTagPermissions,
  TagSummary,
} from "./tag.js";
import type { TokenEventProvenanceFields } from "./token-cost-provenance.js";
import type { TranscriptDisposition } from "./transcript-disposition-constants.js";
import type { TranscriptSkipReason } from "./transcript-skip-reason-constants.js";
import type { TranscriptTurnIdentity } from "./transcript-turn-identity.ts";
import type { BasicUser } from "./user.js";

// ---------------------------------------------------------------------------
// Sync contract types for agent component inventory + usage (T-6.4)
// ---------------------------------------------------------------------------

/**
 * One inventory entry for a harness component, as materialized by the desktop
 * at transcript import time and shipped to the cloud via
 * `POST /desktop/components/sync`.
 *
 * Keyed by `(componentKind, externalComponentId)` on the desktop side; the
 * cloud upserts keyed by `(computeTargetId, componentKind, externalComponentId)`.
 * `uninstalledAt` set ⇒ tombstone the cloud row.
 */
/**
 * FEA-4011: upper bound (characters) on a synced component's IDENTITY fields —
 * `externalId`, `componentKind`, `componentKey`. These feed the org-identity
 * slug and now ride into the `search_document` route metadata (`slug`,
 * `entity_subtype`, `title`), so unlike `content` they were previously
 * unbounded on the wire: a burst of components with pathologically long keys
 * could inflate one query's route metadata into tens of MiB. 512 chars
 * comfortably covers a real component key/kind while capping abuse. The cloud
 * ingest Zod schema rejects anything larger; a slug/route built from these
 * fields therefore has a bounded length.
 *
 * ISS-8051 narrowed the set: `name` is NO LONGER bounded by this constant. The
 * three that remain are the columns of the `AgentComponent` / `AgentComponentVersion`
 * unique indexes, where an over-long value is never stored at all (Postgres
 * refuses a btree index tuple over 2704 bytes) — that is why rejecting is the
 * better failure there. `name` is not an index key, so a rejecting cap on it
 * only cost the whole batch.
 */
export const SYNCED_COMPONENT_IDENTITY_MAX_CHARS = 512;

/**
 * PRODUCER-SIDE bound: the number of `SyncedComponentUsage` entries the desktop
 * slices a session down to before sending.
 *
 * ISS-8051: this is NO LONGER a receive-side cap. The cloud ingest Zod schema
 * used to enforce it with `.max(...)`, and because a Zod `.max()` REJECTS rather
 * than truncates, a session one entry over the cap failed validation entirely
 * and never synced — the total loss FEA-3322 was trying to prevent by keeping
 * the two sides equal was in fact caused by the cap itself. The cloud now
 * accepts whatever arrives, so the two sides drifting apart no longer costs a
 * session; this constant only decides how much the desktop volunteers to send.
 */
export const MAX_SYNCED_COMPONENT_USAGE = 500 as const;

/**
 * F1 (FEA-3290 / PRD-527 Slice 4) — the honest resolution state of an
 * inventory component, mirroring the cloud `ComponentResolvedState` Prisma
 * enum. `unresolved` gates name/label-only rows out of "configured component"
 * (AC-4/AC-7); `inaccessible` (permission-denied, EACCES) is DISTINCT from
 * `missing` (deleted/absent, ENOENT) (AC-5).
 */
export type ComponentResolvedState =
  | "resolved"
  | "unresolved"
  | "inaccessible"
  | "missing";

export type SyncedComponent = SyncedComponentVariantsEnvelope & {
  externalId: string;
  componentKind: string;
  harness?: string | null;
  name?: string | null;
  componentKey?: string | null;
  version?: string | null;
  description?: string | null;
  /**
   * Definition file text (FEA-2923 content pipeline), truncated to
   * `SYNCED_COMPONENT_CONTENT_MAX_CHARS`. Null/omitted for event-driven
   * components with no discoverable definition file.
   */
  content?: string | null;
  /** sha256 hex of the untruncated `content`; the dedup + version key. */
  contentHash?: string | null;
  /**
   * ISS-4662 — ISO; when the PRIMARY revision's exact `contentHash` was first
   * observed locally, read from the desktop's own `agent_component_versions` row.
   *
   * Exists so the primary and the `variants[]` below mean the SAME thing by
   * `firstSeenAt`. Without it the cloud seeded the primary version row from
   * `component.lastSeenAt` (the sync at which the hash surfaced) while each
   * variant carried its true local first-observation, so on the first sync of an
   * install with existing history the current revision was stamped today and its
   * retained siblings their real dates — the same two revisions ordering
   * differently on web than on Desktop (closedloop-ai-stage, #4295).
   *
   * Additive/optional: an older desktop omits it and the cloud falls back to the
   * previous `lastSeenAt` rule, so no existing row is re-keyed or re-dated.
   */
  contentFirstSeenAt?: string | null;
  /**
   * ISS-4965 (Perrin, 2026-10-05): the usage-space digest
   * (`usageScopeHashForContent`) of the definition as written, sent only when
   * `content` was secret-redacted on the way out; omitted otherwise. Usage rows
   * carry that raw-content digest, which the redacted `content` cannot reproduce.
   */
  usageScopeHash?: string;
  /**
   * F1 (FEA-3290 / PRD-527 Slice 4) — honest resolution state (AC-007). One of
   * "resolved" | "unresolved" | "inaccessible" | "missing". Additive/optional:
   * omitted by stale desktop builds, in which case the cloud writer leaves the
   * existing state untouched (never demotes). A label-minted row with no
   * captured definition is "unresolved" and must not surface as a *configured*
   * component; the content collector promotes it to "resolved".
   */
  resolvedState?: ComponentResolvedState | null;
  sourceUrl?: string | null;
  installPath?: string | null;
  packId?: string | null;
  scope?: string | null;
  projectPath?: string | null;
  metadata?: JsonObject | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  uninstalledAt?: string | null;
  /**
   * FEA-3290 (F1, Slice 3) — the Slice-1 provenance-free exact-definition
   * fingerprint of `content`, if the desktop computed it. Additive/optional: an
   * older desktop that predates F1 omits it, in which case the cloud derives the
   * fingerprint itself from `content` via the registry writer (the whole point
   * of F1 owning the hash). Present here only so a future desktop can send the
   * fingerprint it already computed rather than have the cloud recompute — the
   * cloud NEVER trusts a client-supplied hash as identity without re-deriving.
   * A client that omits both this and `content` cannot resolve to a version, so
   * that component's inventory row stays `unresolved` (Slice 4).
   */
  definitionHash?: string | null;
  /**
   * FEA-3290 (F1, Slice 3) — the `NORMALIZER_CONTRACT_VERSION` the client's
   * `definitionHash` was produced under, so a stored hash is never reinterpreted
   * under a later rule set. Additive/optional; omitted by older clients.
   */
  normalizerContractVersion?: number | null;
  /**
   * FEA-3290 (F1, Slice 3) — typed source-evidence: whether the definition body
   * was readable when the desktop scanned it. `inaccessible` (permission-denied)
   * is distinct from a deleted/absent definition (AC-5). Additive/optional;
   * omitted by older clients → treated as `accessible` by the cloud writer.
   */
  accessState?: "accessible" | "inaccessible" | null;
  /**
   * FEA-3290 (F1, Slice 3) — scan timestamp: when the desktop last observed this
   * exact definition on disk (as opposed to `lastSeenAt`, the component's last
   * inventory sync). Additive/optional; the cloud writer falls back to
   * `lastSeenAt`/now when omitted.
   */
  scannedAt?: string | null;
};

/**
 * Per-session usage metrics for a single component, included in the
 * `components[]` array on `SyncedAgentSession`.
 *
 * Keyed by `(agentSessionId, componentKind, componentKey)` in the cloud
 * `agent_component_session_usage` table. `externalComponentId` is nullable —
 * built-in tools (e.g. Read/Bash) have no `AgentComponent` inventory row and
 * resolve `agentComponentId` to null.
 */
export type SyncedComponentUsage = {
  componentKind: string;
  componentKey: string;
  externalComponentId?: string | null;
  harness?: string | null;
  invocations: number;
  errorCount: number;
  firstInvokedAt?: string | null;
  lastInvokedAt?: string | null;
  /**
   * FEA-2990: the git branch this usage bucket actually ran on, from per-event
   * `events.git_branch`. Additive/optional: omitted (or null) for branch-less
   * buckets (Codex, legacy pre-column events, and non-tool kinds), in which case
   * the cloud falls back to session-level `SessionBranch` attribution. A session
   * that switched branches mid-run sends one entry per (component, branch).
   */
  gitBranch?: string | null;
  /**
   * ISS-7259: this component is the session's FIRST ATTRIBUTED SKILL.
   *
   * Named for what it holds, not for what a reader wants it to mean. It derives
   * from the facet's `firstAttributedSkill`, which Claude stamps per assistant
   * turn and never marks as a launch — in this repo's frozen corpus the first
   * stamped turn sits at record 251 of 381, and not one of 105 scanned
   * transcripts carried an attribution on its first record. So a boolean called
   * `launchAttributed` would let a cloud rollup sum it as "sessions this skill
   * launched", which the value cannot support; this name cannot be read that way.
   *
   * A FLAG ON THE INVOCATION ROW, deliberately not a row of its own: "invoked in
   * the session" and "first attributed in the session" are facts about the same
   * (session, component) pair, so a second row would count one `cl-produce` twice
   * and inflate every rollup that sums this table.
   *
   * Omitted rather than sent `false`, so an older cloud that never learned the
   * field is byte-identical to one that learned it and matched nothing.
   */
  isFirstAttributedSkill?: boolean;
  /**
   * FEA-2923: the component's content hash when this usage was recorded
   * (hash-at-invocation). Additive/optional — omitted/null when the definition
   * content had not been collected. Lets the cloud attribute each session/branch
   * to the definition revision that ran.
   */
  componentVersionHash?: string | null;
};

/**
 * Canonical PostHog flag key that gates the Active Runs surface — the live,
 * in-flight view of the Sessions surface (`packages/app`, re-exported via
 * `@repo/app/agents/lib/active-runs`). Importers share this single constant so
 * a typo can't silently gate the surface differently for the same flag.
 *
 * FEA-3660: this previously also gated a server-side "needs your input" push
 * notification derived from the same surface. That notification was removed as
 * noise (the surface already shows awaiting-input state), so the flag now gates
 * only the surface.
 */
export const ACTIVE_RUNS_FEATURE_FLAG_KEY = "emergent" as const;
/**
 * The version a CURRENT desktop build stamps on every batch it sends, and the
 * desktop mirror in `agent-session-sync-contract.ts` moves with it. What the API
 * ACCEPTS is deliberately wider, and lives in
 * `./agent-session-sync-schema-version.ts` — whose `_V2` constant is pinned to
 * this value by a compile-time guard, so the two literals cannot diverge.
 */
export const AGENT_SESSION_SYNC_SCHEMA_VERSION = 2 as const;

/**
 * FEA-4138: wire encoding for the desktop → cloud agent-session sync body.
 * `identity` is the legacy uncompressed JSON shape (what every pre-FEA-4138
 * client and server assumes); `gzip` means the request body is a gzip-compressed
 * JSON batch. The desktop only compresses when the server advertises the
 * `agentSessionSyncCompression` hello-ack capability, so an older server keeps
 * receiving `identity` and an older desktop never emits `gzip` — both skew
 * directions degrade to the uncompressed path.
 */
export const SyncPayloadEncoding = {
  Identity: "identity",
  Gzip: "gzip",
} as const;
export type SyncPayloadEncoding =
  (typeof SyncPayloadEncoding)[keyof typeof SyncPayloadEncoding];

/**
 * FEA-4138: HTTP header the desktop transport stamps on a compressed sync POST
 * (`Content-Encoding: gzip`). The server dispatches decompression on this header
 * because the compressed body is opaque bytes — the `encoding` batch field
 * cannot be read until AFTER the body is decoded, so the wire signal must live
 * outside the compressed payload.
 */
export const SYNC_CONTENT_ENCODING_HEADER = "Content-Encoding" as const;

/*
 * ISS-7019: `AgentSessionState` and `agentSessionStateValidator` were DELETED
 * here, along with `toAgentSessionState`, `TERMINAL_AGENT_SESSION_STATE`, and
 * `deriveAgentSessionFallbackState`.
 *
 * It claimed to be a second, richer axis, but four of its six members
 * duplicated `DISPLAYED_SESSION_STATUS` one-for-one (Completed=inactive,
 * Error=error, PendingApproval=waiting, Running=active) and the other two
 * (Blocked, InReview) had no producer anywhere in the repo — their only
 * occurrences were their own display-map entries. Its one non-derived input,
 * `SessionDetail.state`, is a column nothing has written since the sync path
 * dropped the field.
 *
 * The cost was a row telling two stories: a session silent past the staleness
 * cutoff read "Running" on its detail page while the Sessions list already
 * called it "Stale". The detail Status row now renders the SAME displayed
 * status the list does.
 *
 * Do not reintroduce a second status axis here. If a genuinely new fact about
 * a session needs a home, it is a new field, not a parallel vocabulary for one
 * the row already has.
 */

export const AgentSessionOrigin = {
  DesktopSync: "DESKTOP_SYNC",
  Loop: "LOOP",
} as const;
export type AgentSessionOrigin =
  (typeof AgentSessionOrigin)[keyof typeof AgentSessionOrigin];

export const AgentSessionSyncMode = {
  Backfill: "backfill",
  Incremental: "incremental",
} as const;
export type AgentSessionSyncMode =
  (typeof AgentSessionSyncMode)[keyof typeof AgentSessionSyncMode];

export const DesktopAgentSessionsAckReason = {
  FeatureDisabled: "feature_disabled",
  IngestionFailed: "ingestion_failed",
  RateLimited: "rate_limited",
  ValidationFailed: "validation_failed",
} as const;
export type DesktopAgentSessionsAckReason =
  (typeof DesktopAgentSessionsAckReason)[keyof typeof DesktopAgentSessionsAckReason];

export type DesktopAgentSessionsAck =
  | {
      accepted: true;
      /**
       * Goal stage 2: the `externalSessionId`s the server persisted for THIS
       * request. REQUEST-GATED on `wantsAcceptedSessionIds` and omitted
       * otherwise — installed desktops `.strict()`-parse the response, so the
       * field must never appear unrequested. Absent ⇒ whole-batch semantics.
       */
      acceptedSessionIds?: string[];
    }
  | { accepted: false; reason: DesktopAgentSessionsAckReason; detail?: string };

// FEA-2718: with the event-fragment transport retired, a batch either fully
// syncs or is rejected — there is no longer a `pendingFragments` continuation.
// Goal stage 2: `acceptedSessionIds` is additive + request-gated (see the ack
// type above for the `.strict()` skew rationale).
export type DesktopAgentSessionsSyncResponse = {
  synced: true;
  acceptedSessionIds?: string[];
};

/**
 * Keys-covered guard for this version-skew-sensitive strict response boundary.
 * A new response field must be added here deliberately instead of compiling in
 * a producer while already-installed Desktop validators reject every response.
 */
const desktopAgentSessionsSyncResponseShape = {
  synced: z.literal(true),
  acceptedSessionIds: z.array(z.string()).optional(),
} satisfies Record<keyof DesktopAgentSessionsSyncResponse, z.ZodTypeAny>;

export const desktopAgentSessionsSyncResponseValidator = z
  .object(desktopAgentSessionsSyncResponseShape)
  .strict();

/**
 * FEA-3425: machine-readable `code` values carried in the failure `ApiResult`
 * envelope of `POST /desktop/agent-sessions/sync`. The socket transport names
 * these outcomes inside its ack payload; the REST transport must name them on
 * the HTTP envelope because status alone is ambiguous — 403 is both
 * `feature_disabled` (org capability off → back off and retry later) and
 * `target_not_owned` (wrong/stale computeTargetId → re-resolve identity;
 * waiting cannot fix it), and 500 is both `ingestion_failed` (transient
 * server-side rejection) and `internal_error` (unexpected exception). The
 * desktop HTTP sync client dispatches on code + status, never status alone.
 */
export const DesktopAgentSessionsSyncErrorCode = {
  FeatureDisabled: DesktopWriteLaneRejectReason.FeatureDisabled,
  IngestionFailed: DesktopWriteLaneRejectReason.IngestionFailed,
  InternalError: DesktopWriteLaneRejectReason.InternalError,
  RateLimited: DesktopWriteLaneRejectReason.RateLimited,
  TargetNotOwned: DesktopWriteLaneRejectReason.TargetNotOwned,
  ValidationFailed: DesktopWriteLaneRejectReason.ValidationFailed,
} as const;
export type DesktopAgentSessionsSyncErrorCode =
  (typeof DesktopAgentSessionsSyncErrorCode)[keyof typeof DesktopAgentSessionsSyncErrorCode];

export type SyncedAgentSessionAttribution = {
  repositoryFullName?: string | null;
  worktreePath?: string | null;
  sourceArtifactId?: string | null;
  sourceLoopId?: string | null;
  baseBranch?: string | null;
};

export type SyncedAgentSessionAgent = {
  /** Stable persisted agent-row identity when the producer can expose it. */
  id?: string;
  externalAgentId: string;
  name: string;
  type: string;
  subagentType?: string | null;
  status: string;
  /**
   * ISS-6894: delegated task text, populated ONLY by the transcript-archive
   * reconstruction (`transcript-turn-items.ts` -> `subagentToAgent`), which the
   * cloud parses at the `full` data-sync level. The desktop sync roster does NOT
   * carry it: the producer stopped selecting the column and the ingest schema
   * has no `task` key, so a value here never came off the wire. Do not re-add it
   * to `sync-source.ts` or `desktop-agent-sessions-schema.ts` -- that is the
   * egress the decision on ISS-6894 prohibits.
   */
  task?: string | null;
  currentTool?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  endedAt?: string | null;
  awaitingInputSince?: string | null;
  parentExternalAgentId?: string | null;
  metadata?: JsonObject | null;
};

export type SyncedAgentSessionEvent = {
  externalEventId: string;
  /** Harness-native tool-use identity (for example Claude's `toolu_*`). */
  providerToolUseId?: string | null;
  agentExternalId?: string | null;
  eventType: string;
  toolName?: string | null;
  /**
   * Desktop-local-only turn/tool text. FEA-2718 removed these from the CLOUD
   * lane: the desktop no longer syncs them, and the cloud no longer persists or
   * returns them (the `agent_session_events.summary`/`data` columns are dropped
   * and the sync Zod omits them, so a stale desktop that still sends them has the
   * keys stripped on ingest). They remain optional here solely because the
   * desktop-local detail render still hydrates them from its own local SQLite to
   * build the local trace — so cloud reads leave them `undefined` while the web
   * renders turn/tool detail from the archived transcript (FEA-2717). The
   * desktop → cloud transcript migration is tracked by PRD-461.
   */
  summary?: string | null;
  data?: JsonValue;
  createdAt: string;
};

export type SyncedAgentSessionTokenUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * FEA-3419: additive cache-write TTL subdivision of `cacheWriteTokens`
   * (5-minute vs 1-hour ephemeral prompt-cache writes). Omitted/null = the
   * provider never reported a breakdown (absent provenance — legacy sessions,
   * non-Claude harnesses, pre-TTL desktop builds); explicit 0 = reported zero.
   * Always current-only (compaction baselines are unclassified by design), so
   * `cacheWrite5mTokens + cacheWrite1hTokens ≤ cacheWriteTokens`.
   */
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  estimatedCostUsd?: number;
};

/**
 * FEA-2730 (G1): one raw Desktop token event. New producers use a persisted
 * transport identity; legacy rows keep the content-hash fallback. Replay stays
 * idempotent without treating equal content as duplicate proof.
 */
export type SyncedAgentSessionTokenEvent = TokenEventProvenanceFields & {
  externalEventId: string;
  agentExternalId?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd?: number;
  /** ISO timestamp; persisted as the cloud `eventCreatedAt`. */
  createdAt: string;
};

/**
 * FEA-2730 (G10): the desktop's one-row-per-session analytics rollup
 * (`session_analytics`), synced as-is and authoritative (Q16). Optional +
 * additive — older desktop builds omit it, and an omitted rollup must never
 * clear a previously synced one. `updatedAt` is the desktop's recompute time
 * (persisted as `rollupUpdatedAt`), not a cloud bookkeeping stamp.
 */
export type SyncedAgentSessionAnalytics = {
  startedAt?: string | null;
  startedDay?: string | null;
  status?: string | null;
  harness?: string | null;
  isHuman: boolean;
  humanTurns: number;
  agentTurns: number;
  eventCount: number;
  toolInvocations: number;
  errorEvents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * The session's whole-session cost, in USD.
   *
   * ISS-7176: `null` is a VALUE here, not an absence — it is the desktop's
   * authoritative `sessions.cost_usd_estimated` saying nothing was priced, which
   * is distinct from a subscription session that genuinely cost $0.00. A desktop
   * build predating this omits the field entirely, and the cloud still folds that
   * to `0` exactly as before, so an older client degrades to today's behavior
   * rather than breaking.
   */
  estimatedCostUsd?: number | null;
  runtimeMs?: number | null;
  updatedAt?: string | null;
};

export type TokenEventCostPoint = {
  tMs: number;
  costUsd: number;
  /**
   * FEA-4178: optional owning agent identity (`agents.externalAgentId`) carried
   * from the source `token_events.agent_external_id`. When present, a sub-agent's
   * collapsed-box cost is metered by OWNERSHIP (only this agent's own events),
   * not by timestamp proximity — so overlapping sub-agents can't wear each
   * other's spend. Absent on legacy/ownerless events; the projection then falls
   * back to timestamp attribution and OMITS an ambiguous sub-agent label rather
   * than mis-attribute (see `attributeTokenEventCosts`).
   */
  agentExternalId?: string | null;
};

/**
 * FEA-3788 (PRD-536 D3): metadata identifying a session payload's position in a
 * chunked oversized-session sequence. See `SyncedAgentSession.chunk`.
 */
export type SyncedAgentSessionChunkMeta = {
  /** 0-based position of this chunk in the sequence. */
  index: number;
  /** Total number of chunks the oversized session was split into. */
  total: number;
};

export type SyncedAgentSession = {
  externalSessionId: string;
  name?: string | null;
  /**
   * ISS-8717: the OWNER's chosen session name, as distinct from the
   * collector-derived `name` above. Optional + additive — older desktop builds
   * omit it. An absent value is not "clear the name": it means this payload
   * makes no claim about the override, so the cloud preserves whatever
   * `PATCH /agent-sessions/[id]` already stored. Only a present value writes.
   */
  nameOverride?: string | null;
  /**
   * ISS-10332: the priority set on the desktop in local mode. Optional +
   * additive, and OMITTED on the wire whenever the desktop holds none, so an
   * absent value never means "clear": the cloud adopts a present member only
   * while its own artifact holds no priority (seed-if-unset), and a string
   * outside the vocabulary is dropped rather than failing the session.
   */
  priority?: Priority | null;
  /**
   * ISS-12251: when the session was created, as ISO text: the transcript
   * file's birth time, else its start. Optional + additive, and OMITTED on the
   * wire when the desktop holds none; an older desktop never sends it and the
   * cloud keeps the first-sync time. The cloud stores only a plausible value
   * and only ever moves a stored one earlier.
   */
  createdAt?: string;
  status: string;
  /**
   * Per-session billing mode the desktop resolves from its local billing_mode
   * column (subscription vs. API-key plan). Optional + additive — older desktop
   * builds omit it. The cloud uses it to classify DESKTOP_SYNC sessions (which
   * have no source Loop) in the usage cost split.
   */
  billingMode?: string | null;
  harness?: string | null;
  cwd?: string | null;
  model?: string | null;
  startedAt: string;
  updatedAt: string;
  /**
   * PLN-1034: genuine-activity timestamp — the latest real agent event, floored
   * at startedAt. Optional + additive (older Desktop builds omit it; the cloud
   * derives the authoritative value from the synced event stream regardless).
   * Distinct from `updatedAt`, which is bumped by OTEL ingest / enrichment / sync
   * bookkeeping that is not activity.
   */
  lastActivityAt?: string | null;
  endedAt?: string | null;
  awaitingInputSince?: string | null;
  /**
   * ISS-4586: whether the run ended on an unrecovered error (the desktop's
   * `ends_with_error` flag, stamped at import). Optional + additive — older
   * Desktop builds omit it (absent → the cloud treats it as not-error). The
   * cloud stale-session reaper reads the persisted value to declare an orphaned
   * still-active session `ERROR` vs `INACTIVE` without re-deriving from events.
   */
  endsWithError?: boolean | null;
  metadata?: JsonObject | null;
  attribution?: SyncedAgentSessionAttribution | null;
  /**
   * FEA-1459: device IANA timezone (e.g. "America/Chicago") for timezone-aware
   * day attribution in cloud views and CSV export. Optional + additive — the
   * schema version is unchanged. Older desktop builds omit the field; the cloud
   * treats an absent value as UTC.
   */
  deviceTimeZone?: string | null;
  /**
   * Legacy desktop-produced branch scalar. Accepted for sync version skew, but
   * cloud storage deliberately ignores it; durable session→branch association is
   * represented by synced artifact refs.
   */
  branch?: string | null;
  prs?: SessionPR[] | null;
  wallClock?: string | null;
  activeAgent?: string | null;
  waitingUser?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  gitDiffStats?: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    source: string;
  } | null;
  branchDiffStats?: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    source: string;
  } | null;
  turns?: number | null;
  steeringEpisodes?: number | null;
  autonomy?: number | null;
  activityBuckets?: ActivityBucket[] | null;
  /**
   * FEA-3568: the raw activity-segment tiling (`session_lis`) replicated to the
   * cloud. Optional + additive — older desktop builds omit it and the cloud leaves
   * previously persisted segments untouched (mirrors `tokenEvents`/`activityBuckets`
   * omission semantics; no schema-version bump). Distinct from the derived
   * `ActivitySegment` read shape (FEA-2275) — these are verbatim classifier rows.
   */
  activitySegmentRows?: SyncedActivitySegmentRow[] | null;
  /**
   * FEA-3779: `true` when the desktop truncated the session's raw activity tiling
   * before sync — it exceeded the row cap ({@link MAX_SYNCED_ACTIVITY_SEGMENTS})
   * or the serialized-byte budget ({@link MAX_SYNCED_ACTIVITY_SEGMENT_BYTES}) — so
   * `activitySegmentRows` carries an intentionally partial (start-ordered) prefix.
   *
   * LEGACY: no current desktop build emits it. ISS-4578 replaced cap-truncation
   * with chunking across sync parts, and a tiling past the db-host load ceiling is
   * now OMITTED whole rather than shipped as a prefix, so no current PRODUCER cuts
   * a tiling to a prefix (`apps/desktop/test/sync-source-activity-segments.test.ts`
   * pins both). It stays on the contract because version-skewed FEA-3779..ISS-4578
   * builds still send it.
   *
   * That is a claim about the producer only — it does NOT mean stored cloud state
   * is always whole. A chunked tiling lands over SEPARATE TRANSACTIONS
   * (`persistSessionActivitySegments`): chunk 0 replaces the stored tiling with its
   * slice and later chunks append. Between chunk 0 and the tail — and permanently
   * if the tail never arrives, because retries are exhausted or the desktop
   * quits — the stored tiling is a genuine partial prefix, under
   * {@link MAX_STORED_ACTIVITY_SEGMENTS} and therefore NOT flagged by the
   * read-side derivation either. An in-progress or abandoned sequence is the one
   * way partial cloud state still happens; setting this field would not describe
   * it, since no producer can know mid-sequence that its tail will not land.
   *
   * OMISSION IS NOT A NEGATIVE — absence does not mean the tiling is complete.
   * Before FEA-3779 the assembly cap was a hardcoded 500 rows that truncated
   * SILENTLY, emitting no signal at all, so those payloads and the partial tilings
   * they stored are indistinguishable on the wire from whole ones. That is the same
   * absent-optional-read-as-assertion shape ISS-7265 corrected on
   * {@link SyncedAgentSession.activitySegmentRowsStripped} below.
   *
   * The cloud ingest schema VALIDATES it
   * (`apps/api/lib/desktop-agent-sessions-schema`) and nothing consumes it: no
   * column persists it and no read projection forwards it. The identically named
   * field on {@link AgentSessionDetail} is an INDEPENDENT derivation — the detail
   * read hitting {@link MAX_STORED_ACTIVITY_SEGMENTS} — not this value relayed.
   */
  activitySegmentRowsTruncated?: boolean | null;
  /**
   * ISS-10721: the session's activity-metrics rollup — the autonomy band, the
   * spend split by attribution confidence, and the segment coverage counts.
   *
   * Optional + additive. Omitted by a desktop build that predates it, and
   * omitted (not nulled) for a measure the producer could not compute, so the
   * cloud never stores a zero it was never told. The cloud persists it into
   * `agent_session_activity_metrics`; a payload without the key leaves any
   * stored rollup untouched rather than clearing it, matching `tokenEvents` and
   * `activityBuckets`.
   */
  activityMetrics?: SyncedSessionActivityMetrics | null;
  /**
   * ISS-7265: `true` when this payload OMITS the session's activity tiling
   * entirely because the tiling-in-base shape could not fit the wire cap against
   * a server that does not merge multi-part tilings. Distinct from
   * {@link SyncedAgentSession.activitySegmentRowsTruncated}, which means the
   * tiling IS present but as a partial prefix — here `activitySegmentRows` is
   * absent, and without this flag such a payload is byte-for-byte
   * indistinguishable from a session that simply has no tiling to send.
   *
   * Optional + additive, and OMISSION IS NOT A NEGATIVE. A payload without this
   * key states no opinion on whether a tiling was stripped — a desktop too old
   * to report and a chunk that simply carries no tiling both omit it — so the
   * cloud leaves its column NULL rather than writing `false`. `false` is
   * reserved for a WITNESSED repair (rows this build actually persisted); it is
   * never inferred from an absent key. Producers must therefore send `true` on
   * every delivery that strips, including every chunk of a stripped session's
   * fallback split, rather than relying on a later payload's silence to mean
   * anything. The sync request schema is deliberately non-strict, so an old
   * server drops the key instead of rejecting the batch.
   *
   * Status: no longer inert. The cloud PERSISTS it on
   * `session_detail.activity_segment_rows_stripped` (three-valued — NULL means
   * no payload has ever reported, which is not `false`) and raises the monitored
   * `agent_session_activity_tiling_stripped` event once per batch that committed
   * a stripped session. Desktop-side the strip is counted into the ISS-7248
   * failure diagnostic AND onto the accepted-ack delivery record, both reported
   * as `SyncPayloadShaping.TilingStripped`.
   *
   * Still NOT on any read-side API or UI: the session-detail activity surfaces
   * continue to render a stripped tiling exactly as they render one that was
   * never classified. That layer is deliberately unbuilt here — see ISS-7265's
   * open read-side/UI capability question.
   */
  activitySegmentRowsStripped?: boolean | null;
  /**
   * ISS-9859: marks the PR-list parts of a chunk sequence that paginates a
   * session's `prRefs` and `prs`. The desktop sends it only after the server
   * advertised `agentSessionSyncPrRefChunking`.
   *
   * - `false`: PAGE 0, the first PR-list part. A whole-set replace for both the
   *   stored PR links and the `pullRequests` blob, and the one retraction the
   *   sequence gets. The cloud admits it even when it ties the stored
   *   `updatedAt`, which page 0 always does because base parts land first.
   * - `true`: a later page. The cloud merges it into the stored links and
   *   appends its `prs` to the stored blob.
   * - absent: a base part, or a whole-set payload.
   *
   * Either value is honored only on the chunk position of a sequence of at most
   * {@link MAX_SESSION_SYNC_CHUNKS} parts, and `true` only past index 0. Any
   * other payload is handled as a whole set under the ordinary rules.
   */
  prRefsPaginated?: boolean | null;
  /**
   * ISS-8641 / ISS-8714: the top-level `metadata` keys the producer HELD BUT DID
   * NOT SEND on this payload, because the whole blob could not fit the wire cap
   * (ISS-7997's last-resort degrade).
   *
   * ONE FIELD, NOT A FLAG BESIDE A LIST. A non-empty array IS the degradation
   * declaration: the degrade is reached only after the whole blob failed and an
   * empty degrade is refused, so it always withholds at least one key. A sibling
   * `metadataDegraded` boolean would restate a fact this array already carries
   * and could disagree with it.
   *
   * IT IS THE DISAMBIGUATOR, which is the whole reason it is a list and not a
   * flag. The cloud replaces `metadata` wholesale, so before this field an absent
   * key was ambiguous between "the producer degraded it away" and "the user
   * deleted it", and a receiver that merged on a bare flag would resurrect
   * deleted data. Listed-and-absent means degraded away and the stored value is
   * preserved; UNlisted-and-absent means genuinely gone and the stored value is
   * dropped exactly as it is today.
   *
   * Optional + additive, and OMISSION IS NOT A NEGATIVE. A payload without this
   * key states no opinion, so the cloud keeps today's wholesale replace — which
   * is what every already-installed desktop build sends and must keep doing.
   * Absent is never serialized as `null` by this producer.
   */
  metadataWithheldKeys?: string[] | null;
  span?: SessionSpan | null;
  markers?: SessionMarker[] | null;
  throttles?: SessionThrottle[] | null;
  tracePhaseSources?: SessionTracePhaseSource[] | null;
  throttleSources?: SessionTraceThrottleSource[] | null;
  correctionSources?: SessionTraceCorrectionSource[] | null;
  phases?: SessionPhase[] | null;
  phaseIterations?: PhaseIterations | null;
  phaseLoopbacks?: PhaseLoopback[] | null;
  /**
   * FEA-4022 (PLN-1481, follow-on to FEA-3928): the raw, UNBOUNDED additive
   * session-frustration signal the desktop scorer computed locally, plus the
   * scorer version that produced it. Optional + additive — older desktop builds
   * omit both (→ no frustration data cloud-side; Insights renders empty). The
   * cloud persists them to `SessionDetail.frustration_raw` /
   * `frustration_score_version` ONLY when the org opted into the
   * `calculateSessionFrustration` setting; when off, the value is dropped at
   * ingest and the column stays NULL. Omission preserves whatever the cloud
   * already stored (never nulled by an omitting payload).
   */
  frustrationRaw?: number | null;
  frustrationScoreVersion?: number | null;
  /**
   * ISS-7229: CLAUDE'S OWN reported cost for this session, summed by the desktop
   * from the `claude_code_cost_event` rows Claude Code exports over OTel.
   *
   * NOT a second opinion of the estimate. `SessionDetail.estimatedCost` is
   * priced by our engine from token counts; this is what Claude says it charged,
   * and the two are the OPERANDS of the estimator-drift delta. Nothing may sum
   * or coalesce them.
   *
   * OMITTED, NEVER NULL, when the desktop has no figure — and that is a
   * correctness requirement, not the general cross-repo style rule. A `null`
   * on this field is a write like any other, so it would erase a figure already
   * stored for the session. OTel capture is gated on a Labs setting, so the
   * same session can sync again from a build that captured nothing, and sending
   * `null` for "I captured nothing" would erase what an earlier sync
   * legitimately recorded. Absence means "no
   * opinion, keep what you have"; there is deliberately no wire spelling for
   * "clear it".
   *
   * A present `0` is a REPORTED zero and a real measurement — Claude charged
   * nothing — and is written like any other value.
   */
  authoritativeCostUsd?: number;
  dataRevision?: number | null;
  /**
   * FEA-3788 (PRD-536 D3): per-chunk metadata for an oversized session split by
   * `chunkOversizedSession`. Absent for an unchunked session (a single whole-
   * session payload is implicitly chunk 0 of 1). When present, `index` is the
   * 0-based position in the chunk sequence and `total` is the sequence length.
   *
   * The cloud upsert uses this to make a chunked apply repairable after a partial
   * (half-commit) sync: the events delete-replace fires only on the FIRST chunk of
   * a differing `dataRevision`, and the new `dataRevision` is COMMITTED only on the
   * LAST chunk. A sequence interrupted before its last chunk therefore leaves the
   * stored `dataRevision` at its prior value, so a later resync's first chunk still
   * sees a differing revision (`shouldReplace` re-fires) and fully repairs the
   * session's events instead of masquerading as complete.
   */
  chunk?: SyncedAgentSessionChunkMeta | null;
  artifactRefs?: SyncedArtifactRef[];
  prRefs?: SyncedSessionPrRef[];
  /**
   * ISS-12552: the session's operation claims and coverage. Rides every chunk,
   * like `activityMetrics`; the cloud replaces its evidence when the digest
   * changes. Absent makes no claim (a Desktop build that predates it, or a
   * session with no evidence stored yet).
   */
  operationEvidence?: SessionOperationEvidence;
  agents: SyncedAgentSessionAgent[];
  events: SyncedAgentSessionEvent[];
  tokenUsageByModel: SyncedAgentSessionTokenUsage[];
  /**
   * FEA-2730 (G1): raw per-event token rows. Optional + additive; an omitted
   * array means "no replacement data" and leaves previously persisted rows
   * untouched (like `tokenUsageByModel`). Distributed across chunks for
   * oversized sessions and upserted idempotently cloud-side.
   */
  tokenEvents?: SyncedAgentSessionTokenEvent[];
  /**
   * FEA-2730 (G10): the desktop per-session analytics rollup (1:1). Optional +
   * additive; omission never clears a previously synced rollup.
   */
  sessionAnalytics?: SyncedAgentSessionAnalytics | null;
  /**
   * T-6.4 / AC-011: per-component usage metrics for this session. Optional +
   * additive — older desktop builds omit it; omission leaves previously
   * persisted `agent_component_session_usage` rows untouched. The cloud Zod
   * schema accepts this field before the desktop begins emitting it (deploy
   * ordering: cloud before desktop release).
   *
   * Each entry is upserted into `AgentComponentSessionUsage` keyed by
   * `(agentSessionId, componentKind, componentKey)`. `externalComponentId`
   * resolves to an `agentComponentId` FK via a LEFT JOIN — null for built-in
   * tools that have no inventory row (hook/config/built-in).
   */
  components?: SyncedComponentUsage[];
};

export type DesktopAgentSessionsPayload = {
  /**
   * ISS-6886: the version the SENDER declared, preserved verbatim rather than
   * normalized — rewriting a v1 batch to say `2` would make the parsed payload
   * claim a provenance it does not have. Diagnostic; nothing branches on it.
   */
  schemaVersion: AcceptedAgentSessionSyncSchemaVersion;
  batchId: string;
  syncMode: AgentSessionSyncMode;
  sessionCount: number;
  sessions: SyncedAgentSession[];
  /**
   * FEA-4138: optional, additive wire-encoding declaration (`identity` | `gzip`).
   * Informational — the body is decompressed at the route boundary before this
   * parses — and omitted by every pre-FEA-4138 desktop.
   */
  encoding?: SyncPayloadEncoding;
  /**
   * Goal stage 2: the client's declaration that it can parse
   * `acceptedSessionIds` on the success response. Optional + additive in both
   * skew directions: an old desktop omits it (legacy response shape), and an
   * old server strips it (non-strict request schema) — the new desktop then
   * falls back to whole-batch ack semantics.
   */
  wantsAcceptedSessionIds?: boolean;
  /**
   * ISS-7516 — the data-sync level of the MACHINE that produced this batch, at
   * the moment the batch was built.
   *
   * BATCH-level, not per-session, because it is a property of the sending
   * device: every session in one batch was gated by one setting. The cloud fans
   * it out to each session row it commits, so the served value describes the
   * PRODUCING machine — which is what makes a cross-machine reader's answer
   * correct, and is the one thing a device-local setting could never tell them.
   *
   * Optional and additive in both skew directions: an older desktop omits it and
   * the column stays NULL; a server that predates this field strips it (the
   * request schema is deliberately non-strict) and the desktop loses nothing.
   * MUST be declared on the Zod boundary or it is silently dropped before
   * persistence — see `dataSyncLevelKeyCovered`.
   */
  dataSyncLevel?: DataSyncLevel;
};

export type AgentSessionHarnessBreakdown = {
  harness: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type AgentSessionUsageByUser = {
  userId: string;
  userName: string;
  userEmail: string;
  userAvatarUrl: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type AgentSessionUsageByModel = {
  model: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type AgentSessionLastSyncTarget = {
  computeTargetId: string;
  machineName: string;
  isOnline: boolean;
  lastSeenAt: Date;
  /**
   * ISS-4678 / ISS-4828: the target's last INGEST — the last time session rows
   * from it actually LANDED in the cloud. NOT "last successful sync": ISS-4678
   * narrowed the underlying column so an ACCEPTED batch that persists zero rows
   * (an empty resync, an all-foreign-chunk payload) no longer advances it. A
   * target that just synced successfully with nothing new to send therefore
   * shows its older ingest time here, which is correct for this field and is why
   * `lastAgentSessionSyncAttemptAt` exists for the "did it sync?" question.
   * Null until the target's first session rows land.
   */
  lastAgentSessionSyncAt: Date | null;
  /**
   * ISS-4827 / ISS-4828: the target's last ACCEPTED sync — the last time a
   * session batch from it reached the cloud and was accepted, INCLUDING a batch
   * that carried no new sessions. This is the honest "last successful sync" for
   * a freshness affordance; `lastAgentSessionSyncAt` answers the different
   * question "when did its data last land". Null until the target's first
   * accepted batch. Additive + optional: a version-skewed producer that does not
   * select it omits the key entirely, so consumers must normalize a
   * missing/`undefined` value to `null` rather than assume a `Date`.
   */
  lastAgentSessionSyncAttemptAt?: Date | null;
  owner: BasicUser;
};

export type AgentSessionProjectSummary = {
  id: string;
  name: string;
  slug: string | null;
};

export type AgentSessionComputeTargetSummary = {
  id: string;
  machineName: string;
  isOnline: boolean;
  lastSeenAt: Date;
  /**
   * FEA-3479 (PRD-536 G1): the compute target's last INGEST — the last time
   * session rows from it actually LANDED in the cloud — surfaced per-session
   * (previously only on the usage summary's `lastSyncTargets`).
   *
   * ISS-4828: this is deliberately NOT "the most recent sync". ISS-4678 narrowed
   * the underlying `ComputeTarget.lastAgentSessionSyncAt` column so an ACCEPTED
   * batch that persists zero rows (an empty resync, an all-foreign-chunk
   * payload) no longer advances it — so a target that is online and syncing
   * fine, with nothing new to send, keeps an older value here. Read it as
   * landed-data freshness; use `lastAgentSessionSyncAttemptAt` for "did this
   * target sync successfully". Null until the target's first session rows land.
   *
   * Additive + optional: older wire producers that don't select it omit the key
   * entirely, so consumers must normalize a missing/`undefined` value to `null`.
   * Clients that ignore it are unaffected.
   */
  lastAgentSessionSyncAt?: Date | null;
  /**
   * ISS-4827 / ISS-4828: the compute target's last ACCEPTED sync — the last time
   * a session batch from it reached the cloud and was accepted, INCLUDING a
   * batch that carried no new sessions. The honest "synced Xs ago" value, next
   * to `lastAgentSessionSyncAt`'s "data last landed Xs ago". Null until the
   * target's first accepted batch. Additive + optional on the same terms as the
   * field above: normalize a missing/`undefined` value to `null`.
   */
  lastAgentSessionSyncAttemptAt?: Date | null;
};

export type AgentSessionSourceArtifactSummary = {
  id: string;
  name: string;
  slug: string | null;
  documentType: DocumentType | null;
};

/**
 * A Closedloop artifact (FEAT/PRD/PLN/…) the session referenced or created in
 * its transcript (FEA-3635). The extractor emits these as `closedloop_artifact`
 * refs; the ingest lane resolves each slug to its artifact and records a
 * RELATES_TO ArtifactLink. Projected here so the session detail can surface a
 * clickable link to the artifact — parallel to how {@link SessionPR} surfaces
 * linked PRs. `role` mirrors the link metadata (`input` for a
 * created/launch-configured artifact vs `referenced`/`workspace` for a mention).
 */
export type SessionLinkedArtifact = {
  /**
   * Stable identity for this link within its session — a React key and dedupe
   * key, NOT a value to join on across producers. The cloud serves the resolved
   * artifact UUID (the link target). The desktop-local projection (ISS-5617)
   * never resolved these refs against the cloud, so it has no UUID to serve and
   * puts the artifact's canonical slug here instead. Unique within one session's
   * set either way; do not assume a UUID.
   */
  id: string;
  /** Human slug used for the label + route, e.g. "FEA-3628". Null pre-slug. */
  slug: string | null;
  /** Artifact display name/title, when available. */
  name: string | null;
  /** Document type of the linked artifact (FEATURE/PRD/…), when known. */
  documentType: DocumentType | null;
  /** Link role: `input` (created/configured) vs `referenced`/`workspace`. */
  role: string | null;
};

/**
 * ISS-4449: display cap on the session-detail Linked-artifacts pill row. The
 * synced DOCUMENT refs are budgeted by the desktop producer within the raised
 * `MAX_SYNCED_ARTIFACT_REFS` (500) cloud validator cap — with a guaranteed
 * document floor (ISS-4448) so a PR-heavy session no longer drops them — and the
 * projection can carry dozens of resolved links — rendering all of them as pills
 * would blow out the Properties pane. The
 * projection slices to this many pills and reports the true resolved total via
 * `linkedArtifactsTotal`, so the row shows an honest "N of M" truncation caption
 * (parallel to the activity-strip's `activitySegmentRowsTruncated` note) instead
 * of silently dropping the overflow.
 */
export const MAX_DISPLAYED_LINKED_ARTIFACTS = 20 as const;

export const SessionPrLifecycleStatus = {
  Merged: "merged",
  Closed: "closed",
  Open: "open",
  Unknown: "unknown",
} as const;
export type SessionPrLifecycleStatus =
  (typeof SessionPrLifecycleStatus)[keyof typeof SessionPrLifecycleStatus];

export type SessionPR = {
  num: number | string;
  title: string;
  status: string;
};

export type SessionTimelineEvent = {
  t: string;
  tMs?: number;
  kind:
    | "tool"
    | "edit"
    | "mcp"
    | "slash"
    | "result"
    | "event"
    | "human"
    | "say";
  who?: string;
  title?: string;
  detail?: string;
  err?: boolean | string;
  git?: boolean;
  tl?: number;
  /** Model that produced an assistant `say` row, surfaced as a bubble caption. */
  model?: string | null;
  /** Marks an assistant `say` row as a reasoning/thinking block. */
  isThinking?: boolean;
  /**
   * Marks a content-free end-of-turn hook (`Stop`/`SubagentStop`). Set from the
   * raw producer hook name so the detail projection can drop it structurally
   * rather than by matching display text.
   */
  isBoundary?: boolean;
  /**
   * ISS-12467: marks the importer's per-turn `TurnDuration` row. Set from the
   * raw producer event type. The detail projection renders no row for it but,
   * unlike `isBoundary`, it still ends a tool run.
   */
  isTurnDuration?: boolean;
  /**
   * FEA-3547: full per-call tool detail preserved from the source event's `data`
   * so the tools-turn projection can carry it onto each `ToolItem` (the one-line
   * `detail` above is a lossy summary). Optional/additive — populated only for
   * tool-like rows whose producer supplied `tool_input`/`tool_response`
   * (transcript path); the cloud DB-events path strips `data`, so these stay
   * undefined and the trace row falls back to its empty state.
   */
  toolInput?: string;
  toolInputTruncated?: boolean;
  toolOutput?: string;
  toolOutputTruncated?: boolean;
  /** Wall-clock ms between the tool_use and its tool_result, when derivable. */
  toolDurationMs?: number;
  /** Short status token (e.g. `exit 0`) parsed from the tool response. */
  toolStatus?: string;
  /** Stable source identities used by invocation-evidence transcript anchors. */
  transcriptIdentity?: TranscriptTurnIdentity;
  /**
   * FEA-3696: stable identity of the source tool event (its `externalEventId`),
   * threaded so the tools-turn projection can mint a `ToolItem.callId` that is
   * identical across the cloud DB-events path and the desktop transcript path.
   */
  toolCallId?: string;
  /**
   * FEA-3696: truthful availability of this tool event's expanded detail.
   * Distinguishes "detail exists but was redacted/unparseable" from "detail was
   * simply not hydrated into this response" so the projection can stamp a
   * {@link ToolCallDetailState} the UI renders honestly.
   */
  toolDetailState?: ToolCallDetailState;
};

/**
 * ISS-5999: the bar shape lives in its own module now — see
 * `activity-bucket.ts`. Re-exported here so every existing consumer keeps its
 * `@repo/api/src/types/agent-session` import.
 */
export type { ActivityBucket } from "./activity-bucket";
/**
 * The turn identity record lives in its own dependency-free leaf now — see
 * `transcript-turn-identity.ts`, which also documents why it had to leave this
 * module. Re-exported here so every existing consumer keeps its
 * `@repo/api/src/types/agent-session` import.
 */
export type { TranscriptTurnIdentity } from "./transcript-turn-identity.ts";

/**
 * FEA-2275: the derived per-phase activity breakdown — the read shape the
 * session-detail "activity breakdown" panel renders, and the reuse target for
 * the FEA-2276 branch rollup. It is the per-phase analog of the time-axis
 * {@link ActivityBucket}: one entry per phase key, aggregated from the raw
 * {@link SyncedActivitySegmentRow} tiling joined with the session's token
 * events.
 *
 * DISTINCT from `SyncedActivitySegmentRow` (the verbatim classifier rows on the
 * sync wire): this is a priced/aggregated rollup and never rides the wire. It is
 * computed once in `@repo/lib` (`buildActivitySegments`) and forwarded
 * identically by the cloud (`apps/api`) and desktop (`mapDetail`) detail
 * projections, so web and desktop render identically — parity by construction
 * (PLN-1198 Amendment v3 item 3).
 *
 * `costUsd` is the single authoritative price (FEA-2276 reads it directly rather
 * than re-pricing). There is intentionally NO USD in/out/cache decomposition
 * here: the stored per-event data carries one total cost, so the in/out/cache
 * split this type exposes is in TOKENS (`inputTokens` / `outputTokens` /
 * `cacheReadTokens` / `cacheWriteTokens`, which stay separate here).
 * Per-phase `costUsd` and token counts (including the `other` and `idle`
 * remainders) reconcile exactly to the token events fed into
 * `buildActivitySegments` — not necessarily to the session totals, since the
 * cloud falls back to the stored rollup for unpriced or incomplete event
 * streams and desktop can derive totals from `tokenUsageByModel`.
 */
export type ActivitySegment = {
  /**
   * Stable phase key (matches `SyncedActivitySegmentRow.phase` /
   * `SessionPhase.key`). The literal `other` key carries the unclassified
   * remainder; `idle` carries non-working wall-time.
   */
  key: string;
  /**
   * A self-describing display label carried on the wire for API consumers of
   * `activitySegments`, so they need not replicate the phase taxonomy.
   *
   * ISS-4790: for every key in the known taxonomy this is literally the same
   * string the Closedloop web/desktop UI renders — producer and UI both read
   * `ACTIVITY_PHASE_LABEL` (`@repo/api/src/activity-phase-labels`). The UI still
   * resolves its own labels from that map rather than from this field, because
   * it also owns the phase COLOR and must label the raw `activitySegmentRows`
   * timeline bands (which carry no label); but the two can no longer disagree,
   * they share one source. Keys OUTSIDE the taxonomy (a future classifier
   * version) are titleized identically on both sides too — producer and both
   * display maps run the same shared `labelize`, so a compound key such as
   * `auto-review` reads "Auto Review" everywhere rather than "Auto-review" here
   * and "Auto Review" in the UI.
   */
  label: string;
  /**
   * Absolute per-phase token counts, summed from the token events whose
   * timestamp falls within this phase's spans. `inputTokens` is uncached input;
   * cache read/write are separate additive components (same convention as the
   * `genai-cost` engine and `ActivityBucket`).
   */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * The single authoritative per-phase priced USD cost — the sum of the
   * per-event `estimatedCostUsd` of the token events binned into this phase.
   * The one cost number downstream consumers read (FEA-2276 consumes it
   * directly rather than re-pricing), so branch rollup and session detail can
   * never diverge on price.
   */
  costUsd: number;
  /** Wall-time attributed to the phase (sum of its half-open spans), in ms. */
  durationMs: number;
  /**
   * Attribution confidence in [0, 1] — the duration-weighted mean of this
   * phase's segment-row confidences. This is the NUMERIC per-phase confidence
   * the UI surfaces; distinct from `source` (which records only the
   * inferred-vs-declared provenance, not how confident the attribution is).
   * `null` for a synthesized remainder that carries no confidence-bearing rows.
   */
  confidence: number | null;
  /**
   * Inferred-vs-declared provenance: `explicit` (declared) when the phase's
   * rows were labeled from a declared evidence layer, else `loop_perf`
   * (inferred). Reuses the existing {@link SessionTracePhaseSourceType} enum as
   * the discriminator rather than a new boolean. `null` for the synthesized
   * `other` remainder / evidence-free spans.
   */
  source: SessionTracePhaseSourceType | null;
  /**
   * Marks the honest `other`/unclassified remainder so the renderer styles and
   * labels it distinctly and never drops it.
   */
  isUnclassified?: boolean;
};

/**
 * FEA-3568 / FEA-3779: max raw activity-segment rows accepted per session in ONE
 * sync PAYLOAD. It is a PER-CHUNK wire bound, not a per-session ceiling — that is
 * {@link MAX_STORED_ACTIVITY_SEGMENTS}.
 *
 * This is a single SSOT constant, deliberately NOT an env knob: it bounds both
 * the desktop's per-chunk row ceiling AND the cloud ingest Zod `.max(...)`, so
 * cloud and desktop MUST agree on the exact value. An env-derived bound could
 * desync the two sides — the cloud would then reject payloads the desktop
 * considered valid (or vice versa). Tune it here, in one place, and both
 * surfaces move together.
 *
 * ISS-4578: a tiling past this bound is no longer TRUNCATED to fit. The desktop
 * paginates it across sync parts (`chunkOversizedSession` passes this value as
 * `appendPaginatedChunks`'s per-chunk row ceiling, so every emitted chunk stays
 * acceptable to the route), and the cloud merges the parts additively, so a
 * session's stored tiling routinely holds many more rows than this. Exceeding
 * this value is therefore NOT a data-loss point and does NOT raise
 * {@link SyncedAgentSession.activitySegmentRowsTruncated} — read that field's doc
 * before assuming otherwise; no current desktop build emits it at all.
 *
 * FEA-3779: raised from the original 500, which WAS a truncation point — a wild
 * session was observed with 1051 segments (>2x the cap), so ~half its activity
 * tiling was silently truncated and the cloud stored a partial tiling. That
 * history is why the value is set well above the observed p95/p99 rather than at
 * a bare round number: a chunk boundary is cheap, but a tiling whose every chunk
 * is mostly overhead is not.
 */
export const MAX_SYNCED_ACTIVITY_SEGMENTS = 5000;

/**
 * ISS-4541: the maximum number of activity-segment rows the cloud STORES and
 * READS BACK for a single session.
 *
 * This is DISTINCT from {@link MAX_SYNCED_ACTIVITY_SEGMENTS}, which since
 * ISS-8051 is a PRODUCER-SIDE chunk target — the most rows the desktop puts in
 * any ONE sync chunk — and no longer a receive-side cap the ingest schema
 * enforces with `.max(...)`; that `.max()` rejected the whole session. Since
 * ISS-4541 an oversized tiling is PAGINATED across chunks and MERGED additively
 * on the cloud, so a session's STORED tiling can hold many more rows than one
 * payload — up to this ceiling, which aligns with the desktop producer's own
 * per-session load bound (`ACTIVITY_SEGMENT_SYNC_MAX_ROWS`, 50k). The detail and
 * branch-attribution read paths bound their `take` to this value (not the wire
 * cap) so a legitimately-chunked tiling of >5k rows is read back IN FULL rather
 * than silently clipped at 5k. A read that hits this ceiling surfaces
 * `activitySegmentRowsTruncated`, never a silent undercount.
 */
export const MAX_STORED_ACTIVITY_SEGMENTS = 50_000;

/**
 * FEA-3595 / ISS-8271: inclusive upper bound on the `dataRevision` the cloud
 * will COMMIT for a session. Since ISS-8271 the wire schema accepts any
 * integer (a schema rejection was batch-wide and stranded sessions); the bound
 * is enforced at the apply by `resolveWireDataRevisionDisposition`
 * (apps/api `wire-data-revision.ts`) — a value above it is HELD per session
 * (`revision_too_new`: nothing written, id withheld from the ack echo so the
 * desktop re-sends), never committed.
 *
 * Revision gating is forward-only (`chunk-revision-gating.ts`): a payload below
 * a session's committed/pending high-water mark is rejected as stale. That
 * makes the high-water mark effectively IRREVERSIBLE and client-supplied, so an
 * unbounded `dataRevision` is a denial-of-service on a single session — one
 * payload carrying `2147483647` (Postgres `Int` max) commits, after which every
 * genuine repair from a real desktop is stale forever and the next integer
 * cannot be stored at all.
 *
 * The bound is deliberately far above any reachable real value and far below
 * `Int` max: the desktop `DATA_REVISION` is in the low tens and has historically
 * advanced ~10 per month, so this is decades of headroom while still refusing
 * the poison values. Raise it if that ever stops being true — a legitimate
 * revision hitting this ceiling should be a deliberate bump of this constant,
 * not an indefinite per-session hold.
 */
export const MAX_SUPPORTED_DATA_REVISION = 10_000 as const;

/**
 * ISS-9859: the most parts one session may be split into for one sync. The
 * desktop chunk packer stops at this count
 * (`apps/desktop/src/main/agent-sync/agent-session-sync-chunk-packer.ts`), and
 * the cloud honors a `prRefsPaginated` marker only on a sequence no longer than
 * this. `chunk.total` is client-controlled and the wire schema bounds it from
 * below only, so a marked part claiming more parts is treated as a whole set
 * (Replace) rather than merged.
 */
export const MAX_SESSION_SYNC_CHUNKS = 100 as const;

/**
 * FEA-3779: the byte budget the desktop USED TO cut a session's serialized
 * `activitySegmentRows` at, in serialized-JSON bytes.
 *
 * RETIRED AND CURRENTLY UNREFERENCED — do not read this as a live bound. Nothing
 * in the repo imports it: `grep MAX_SYNCED_ACTIVITY_SEGMENT_BYTES` returns this
 * declaration and the one {@link SyncedAgentSession.activitySegmentRowsTruncated}
 * `@link` back to it, nothing else. It bounded the FEA-3779 assembly cap, and
 * ISS-4578 deleted that path: the tiling is now paginated across sync parts by
 * `chunkOversizedSession`, which bounds each part against the transport's own
 * per-request budget rather than this constant, so nothing measures a tiling
 * against 128 KiB any more. Its removal is a separate change (it is an exported
 * symbol) — until then, treat it as history, not as a cap in force.
 *
 * Why FEA-3779 needed a byte cap at all, since the reasoning still explains the
 * value: `activitySegmentRows` then rode in the session's NON-paginated base
 * payload, replicated whole into every chunk. If the base alone exceeded
 * `SESSION_PAYLOAD_BYTE_CAP` (256 KiB), `chunkOversizedSession` returned `[]` and
 * the WHOLE session dead-lettered. 128 KiB left 128 KiB for the rest of the base
 * — the metadata preview is itself bounded to ~76 KiB
 * ({@link MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS} + per-message floor) — so the
 * base stayed under the transport cap and the session always synced, partial
 * rather than dead-lettered. At ~150–190 bytes per real row that admitted only
 * ~700–870 rows, well BELOW {@link MAX_SYNCED_ACTIVITY_SEGMENTS}: on a legacy
 * FEA-3779..ISS-4578 build the byte cap, not the row cap, is what a truncated
 * tiling almost always hit, which is why a legacy partial tiling is short rather
 * than exactly 5000 rows. Paginating the tiling removed the trade entirely.
 */
export const MAX_SYNCED_ACTIVITY_SEGMENT_BYTES = 131_072;

/**
 * FEA-3568: one raw activity-tiling row on the per-session sync wire — the
 * desktop `session_lis` shape (FEA-2267) replicated verbatim to the cloud. It is
 * DISTINCT from the derived per-phase `ActivitySegment` read shape owned by
 * FEA-2275: this carries the half-open span + provenance the classifier persists,
 * never a re-priced/aggregated rollup. The cloud stores these rows verbatim and
 * never re-classifies (PLN-1398 design decisions 2 and 4).
 */
export type SyncedActivitySegmentRow = {
  /**
   * Activity phase label. A bounded free string, NOT a closed union: the desktop
   * stores `phase` as TEXT and a taxonomy change is a classifier-version bump +
   * re-derive (Q-001), so the wire and cloud stay agnostic to the label set and
   * never need a contract change when the taxonomy grows.
   */
  phase: string;
  /** epoch-ms, inclusive lower bound. */
  startMs: number;
  /** epoch-ms, exclusive upper bound — half-open [startMs, endMs). */
  endMs: number;
  /** Attribution confidence in [0, 1]. */
  confidence: number;
  /**
   * Ranked evidence-layer names (`declared`/`structural`) that fed the label;
   * empty for `idle` and evidence-free `other` spans. Layer names only — no prose,
   * preserving the FEA-2718 no-turn-text posture of this lane.
   */
  evidenceLayers: string[];
  /** Deterministic classifier version that produced the row; the re-derivation key. */
  version: number;
  /** Optional artifact ref this span's work was linked to (FEA-2272). */
  workItemRef?: string | null;
  /**
   * Optional parser-stable local subagent id when this span is delegated spend
   * re-filed to a subagent's own purpose phase (FEA-2271); null for main-agent spans.
   */
  subagentId?: string | null;
};

export const SessionTracePhaseSourceType = {
  LoopPerf: "loop_perf",
  Explicit: "explicit",
} as const;
export type SessionTracePhaseSourceType =
  (typeof SessionTracePhaseSourceType)[keyof typeof SessionTracePhaseSourceType];

export type SessionTracePhaseSource = {
  sourceType: SessionTracePhaseSourceType;
  phaseKey: string;
  label?: string | null;
  startedAt: string;
  endedAt?: string | null;
};

export const SessionTraceThrottleSourceType = {
  ProviderRateLimit: "provider_rate_limit",
  UsageLimit: "usage_limit",
  ApiError: "api_error",
  TokenSnapshot: "token_snapshot",
} as const;
export type SessionTraceThrottleSourceType =
  (typeof SessionTraceThrottleSourceType)[keyof typeof SessionTraceThrottleSourceType];

export type SessionTraceThrottleSource = {
  sourceType: SessionTraceThrottleSourceType;
  provider: string;
  observedAt: string;
  limitKind?: string | null;
  statusCode?: number | null;
  errorCode?: string | null;
  resetAt?: string | null;
  retryAfterSeconds?: number | null;
};

export const SessionTraceCorrectionSourceKind = {
  ManualRegression: "manual_regression",
  ReviewChangeRequest: "review_change_request",
  ApprovalDenied: "approval_denied",
  NegativeFeedback: "negative_feedback",
  ExplicitCorrection: "explicit_correction",
} as const;
export type SessionTraceCorrectionSourceKind =
  (typeof SessionTraceCorrectionSourceKind)[keyof typeof SessionTraceCorrectionSourceKind];

export type SessionTraceCorrectionSource = {
  kind: SessionTraceCorrectionSourceKind;
  observedAt: string;
  label?: string | null;
  sourceType?: string | null;
};

/**
 * The trace's DERIVED render shapes, extracted to `./session-trace-shape`
 * (ISS-5636) — the same shrink-only split `./activity-bucket` made above, and
 * for the same reason. The `SessionTrace*Source` evidence records they are
 * folded FROM stay here, beside the source-kind const objects that discriminate
 * them. Re-exported so every existing importer of this module keeps resolving
 * them unchanged.
 */
export type {
  PhaseIterations,
  PhaseLoopback,
  SessionMarker,
  SessionPhase,
  SessionSpan,
  SessionThrottle,
} from "./session-trace-shape.ts";

/**
 * The transcript's DERIVED render shapes, extracted to
 * `./session-transcript-turn` — the same shrink-only split `./activity-bucket`
 * and `./session-trace-shape` made above, and for the same reason. Re-exported
 * so every existing importer of this module keeps resolving them unchanged.
 */
export type {
  SubagentBodyLine,
  TurnActor,
  TurnItem,
} from "./session-transcript-turn.ts";

/**
 * @deprecated Compatibility type for stale clients that may still import the
 * removed Session Trace state-action endpoint response.
 */
export type AgentSessionStateUpdateResponse = {
  /**
   * ISS-7019: typed `string`, not the deleted `AgentSessionState`. The route is
   * a 410 tombstone that never emits a body, so this shape exists only so a
   * stale bundle's import still resolves.
   */
  state: string;
};

export type AgentSessionListItem = {
  id: string;
  // SES-* slug of the backing Session artifact (FEA-1699). Null only until a
  // slug is allocated (every synced/backfilled session has one).
  slug: string | null;
  externalSessionId: string;
  name: string | null;
  /**
   * Producer-owned lifecycle evidence retained beside the derived display
   * {@link status}. Optional for compatibility with older API and Desktop
   * producers, whose consumers fall back to `status` when it is omitted.
   */
  rawStatus?: string | null;
  status: string;
  /**
   * ISS-10332: `null` is "no priority"; OMITTED is "this producer does not know"
   * (an older API or Desktop build), which a consumer must not read as unset.
   * `project` below is optional for the same reason (ISS-10995): single-user
   * Desktop has no project concept and omits the key, and the editable Details
   * row keys on that absence.
   */
  priority?: Priority | null;
  /**
   * The Session Artifact row's ownership and lifecycle fields. `assignee` is
   * the session's Owner, the field every artifact type uses (ISS-12251 D-1);
   * Created by is the artifact's CREATOR. ISO-8601 strings, as the sibling
   * `createdAt` contracts on this route are. Additive and optional: an older
   * producer omits every key, and `null` on a nullable one is a read that found
   * none.
   */
  assignee?: BasicUser | null;
  createdAt?: string;
  createdBy?: BasicUser | null;
  dueDate?: string | null;
  origin?: AgentSessionOrigin;
  harness: string;
  cwd: string | null;
  repositoryFullName: string | null;
  repo?: string | null;
  worktreePath: string | null;
  model: string | null;
  primaryModel?: string | null;
  /**
   * ISS-7895: the models this session actually BILLED — never the models it
   * merely declared, which stay on `model`/`primaryModel`. Both producers
   * derive it through `deriveBilledModels`
   * (`../agent-session-billed-models.ts`), which is what stops the cloud and
   * desktop answering the question differently again.
   *
   * OMITTED means "not computed on this path", not "none": the session LIST
   * queries skip the token-usage join for performance (ISS-7598), so only the
   * DETAIL projections populate it. `[]` is the computed answer for a session
   * that billed nothing, and callers must not fall back to the declared model.
   */
  models?: string[];
  branch?: string | null;
  /**
   * FEA-4256: the session's own branch-detail destination, resolved from the
   * session→branch `ArtifactLink` (prefer the branch the session WROTE; else the
   * strongest linked branch). Lets the Sessions table and session detail link
   * the repo/branch/PR display to that branch instead of an external GitHub tab.
   * Additive + optional: a session with no resolvable linked branch (read-only
   * runs, legacy rows, version-skewed producers) omits the key, and the display
   * degrades to a non-link chip rather than a dead route.
   *
   * ISS-5567: treat this as an OPAQUE route token whose format belongs to the
   * PRODUCER, not as a Branch artifact UUID. The cloud projection emits the
   * artifact id, addressable at `/{org}/branches/{branchArtifactId}`; the desktop
   * detail read emits `encodeBranchId({repoFullName, branchName})`, addressable
   * at the desktop's own `/branches/{branchArtifactId}`. Each is resolvable only
   * by the surface that minted it, so consumers must hand it to that surface's
   * href builder — never parse it, join on it, or send it to an API expecting a
   * UUID.
   */
  branchArtifactId?: string | null;
  prs?: SessionPR[];
  prsMerged?: number;
  /**
   * FEA-3635: Closedloop artifacts (FEATs/PRDs/…) the transcript referenced or
   * created, resolved from the extractor's `closedloop_artifact` refs. Surfaced
   * on the session detail as clickable links, parallel to `prs`. Optional +
   * additive: producers that don't project it omit the key; consumers treat a
   * missing/empty value as "no linked artifacts" and render nothing extra.
   */
  linkedArtifacts?: SessionLinkedArtifact[];
  /**
   * ISS-4449: the TRUE count of resolved DOCUMENT links for this session, before
   * the {@link MAX_DISPLAYED_LINKED_ARTIFACTS} display cap slices `linkedArtifacts`
   * for the pill row. When this exceeds `linkedArtifacts.length` the served set was
   * truncated, and the detail row must surface an honest "N of M" caption instead
   * of silently dropping the overflow. Additive + optional: a version-skewed
   * producer that omits it degrades to `linkedArtifacts.length` (no truncation
   * claimed), so a missing value never fabricates a truncation indicator.
   */
  linkedArtifactsTotal?: number | null;
  /**
   * FEA-4204: how many comment THREADS this session carries, so the Sessions
   * list can mark a discussed session without a per-row fetch. Every artifact
   * counts the same way (operator ruling, ISS-9404 review on #8671): native and
   * Liveblocks threads, replies not incremented, resolved threads included, a
   * thread whose comments were all deleted excluded. Sessions have no Liveblocks
   * threads, so this is their native thread count. Derivation:
   * `apps/api/app/artifacts/collaborators/direct-comment-count-service.ts`.
   * GitHub review comments are not a source — they sync INTO ClosedLoop against
   * the branch they belong to.
   *
   * Optional + additive, and ABSENT IS NOT ZERO. A producer that did not batch the
   * count omits the key (a version-skewed Desktop build, the desktop local-first
   * read, or `listSessionsByArtifactIds`), which means "no count available" and
   * must render nothing. A computed `0` is served as `0`. A consumer that folds
   * the two together prints a confident "0 comments" on a session it never
   * counted.
   */
  commentCount?: number;
  /**
   * Org-level custom-field values attached to this Session artifact. Additive
   * and optional for version-skewed producers: omitted means the producer did
   * not load this projection, while `[]` is a successful read with no values.
   * Field definitions independently declare which entity types they apply to,
   * so a Session field does not become a Document field implicitly.
   */
  customFields?: CustomFieldValueDetail[];
  /**
   * ISS-8712: the ORG TAG VOCABULARY applied to this session's Artifact — the
   * same `TagArtifact` join a PRD, an Issue, or a Branch carries, so a tag
   * applied here is the same record those surfaces show.
   *
   * Distinct from {@link customFields} above, which is the org's own
   * per-entity field definitions; a custom field named "Tags" is not this.
   *
   * Additive and optional for version-skewed producers, with the same
   * three-state contract the Branch read uses: omitted means this producer did
   * not load the relation (see {@link tagAvailability}), `[]` is a successful
   * read that found none.
   */
  tags?: TagSummary[];
  /** Distinguishes a loaded tag relation from unavailable/unknown tag data. */
  tagAvailability?: ArtifactTagAvailability;
  /**
   * Auth-derived tag capabilities; omitted when unknown. A display affordance
   * only — `/entity-tags` re-checks scope and org ownership on every write.
   */
  tagPermissions?: ArtifactTagPermissions;
  cost?: string | null;
  wallClock?: string | null;
  activeAgent?: string | null;
  waitingUser?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  gitDiffStats?: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    source: string;
  } | null;
  branchDiffStats?: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    source: string;
  } | null;
  /**
   * FEA-4250 / FEA-4378 / ISS-4667: per-session KLOC (thousand lines of code
   * changed, a VOLUME figure) and LOC/$ cost-efficiency, projected server-side so
   * every consumer of the read contract (web, desktop renderer, raw API clients)
   * sees the same value instead of re-deriving it locally.
   *
   * ISS-9964 / ISS-9980 (RULED 2026-09-11): the numerator is
   * `mergedAuthoredPrLinesChanged` and NOTHING ELSE — the lines this session
   * actually landed, through the shared `locPerDollarNumeratorLines`
   * (`@repo/api/src/utils/loc-per-dollar`). The earlier
   * `max(localWorkingTreeDiff, branchDiffLines, mergedAuthoredPrLinesChanged)`
   * rungs are RETIRED: a local working tree and an unmerged branch diff both
   * measure work in progress, and mixing them into a delivered-code rate is what
   * let a session's LOC/$ move because a branch was pushed. Branches LOC/$
   * counts lines pushed to origin (ISS-9958); that difference is INTENTIONAL —
   * the two surfaces measure different things on purpose. The `@deprecated`
   * `authoredPrLinesChanged` is a compatibility field, not a term of this
   * numerator: a session carrying only that key is NOT KNOWABLE, because it
   * predates the merge gate and cannot answer the merged question.
   *
   * `kloc = numerator / 1000`;
   * `locPerDollar = numerator / estimatedCost` — ISS-4667: raw LINES per dollar,
   * NO divide-by-1000 and never inverted, so the ratio reconciles directly with
   * the same panel's "Lines changed" and "Cost". Consumers MUST NOT reimplement
   * the old `(linesAdded + linesRemoved)`-only formula.
   *
   * The two fields differ on a numerator of ZERO, deliberately:
   *   - `locPerDollar` DIVIDES it. A numerator that is known and zero is a fact
   *     about the population — "this session merged nothing, and you spent $X" —
   *     so it is a real `0`. It is `null` only when the numerator is NOT
   *     KNOWABLE (no producer supplied the merge-gated count), when there is no
   *     cost to divide by (`estimatedCost <= 0` — arithmetic, not data), or when
   *     either input is non-finite.
   *   - `kloc` is a VOLUME, not a rate, and keeps its own FEA-4250 rule: `null`
   *     for zero or non-finite churn, so a volume card renders the placeholder
   *     instead of a misleading `0.0`.
   *
   * Optional + additive: a version-skewed producer that omits them degrades to
   * the client's local derivation.
   *
   * `klocPerDollar` is DEPRECATED (ISS-4667) — the KLOC-unit predecessor of
   * `locPerDollar` (thousand lines per dollar). Retained ONLY so a Desktop build
   * or cached response that predates ISS-4667 is still understood on read:
   * consumers resolve it through `resolveLocPerDollar`, which scales it into
   * LOC/$ instead of rendering a figure a thousand times too small. This repo's
   * producers no longer emit it on a session row.
   */
  kloc?: number | null;
  locPerDollar?: number | null;
  klocPerDollar?: number | null;
  /**
   * FEA-4378 / ISS-6114: total lines *changed* (`additions + deletions`) summed
   * across the MERGED PRs the session authored, deduped by PR identity, from
   * platform-verified PR detail — the branch's current pointer AND its historical PR set, so a PR
   * superseded on a reused branch still counts. Each PR is included only with BOTH
   * a verified `additions` and `deletions`; a partial/unfetched row is unavailable
   * and contributes nothing (never coerced to an understated total). The real
   * delivered-code signal for a multi-PR session, distinct from the session-level
   * `linesAdded/linesRemoved` scalars — which are the LOCAL working-tree git diff
   * and collapse to a tiny residual once a session's branches are merged/reset.
   * ISS-9964 / ISS-9980 (RULED 2026-09-11): this field IS the server-projected
   * `kloc` / `locPerDollar` numerator (through the shared
   * `locPerDollarNumeratorLines`), and the detail view's own "Lines changed" row
   * renders the same resolution. One population, one number.
   *
   * `0` and `null` are different answers and must not be collapsed:
   *   - `0` is a MEASUREMENT that found nothing to credit — the session authored
   *     no PR with a complete verified LOC detail, or (since ISS-6114) its
   *     authored PRs are all still open, merged being the gate, so unlanded work
   *     credits nothing. It is not a claim about PR count, and it divides into a
   *     real `0` LOC/$.
   *   - `null` is NOT KNOWABLE — nobody could look. It is emitted when the
   *     session's PRs are SUPPRESSED because no head branch resolves (the same
   *     gate that empties the rendered `prs`), and when a matching merged PR's
   *     per-PR LOC row is unreachable (ISS-4448's session: 88 merged PRs whose
   *     `additions`/`deletions` cannot be resolved). Consumers render NOT
   *     AVAILABLE and must never substitute `0`, which would report a
   *     measurement nobody took.
   *
   * Optional + additive: a version-skewed producer that omits it degrades to the
   * client's local derivation.
   */
  mergedAuthoredPrLinesChanged?: number | null;
  /**
   * @deprecated ISS-6114 renamed this to {@link mergedAuthoredPrLinesChanged}.
   *
   * The value was never "authored PR lines" alone once the merge gate landed —
   * it is the lines changed across the MERGED PRs a session authored — and the
   * old name understated the gate by exactly the population the ticket was filed
   * about. Both qualifiers carry weight: `authored` excludes a referenced or
   * reviewed PR, `merged` excludes one still open.
   *
   * STILL EMITTED, carrying the identical value, because this is a cloud→client
   * READ contract and an installed Desktop build reads it by the old name. A
   * client that never learns the new one would silently fall back to its local
   * working-tree diff — degraded rather than broken, but wrong, and invisible.
   * Removing this alias needs explicit human approval (repo Compatibility
   * Guardrail); it is not a cleanup to fold into an unrelated change.
   */
  authoredPrLinesChanged?: number | null;
  turns?: number | null;
  toolCallsTotal?: number | null;
  steeringEpisodes?: number | null;
  autonomy?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  cache?: number | null;
  cacheWrite?: number | null;
  /**
   * ISS-8772 took the last in-repo reader: the trace now seats its human actor
   * on the shared actor-colour authority instead of this per-user hash. Both
   * producers still serve it and version-skewed clients may still read it, so it
   * stays — but nothing here consumes it, and a new consumer should ask whether
   * it wants this hash or that authority before reaching for it.
   */
  userColor?: string | null;
  activityBuckets?: ActivityBucket[];
  span?: SessionSpan | null;
  markers?: SessionMarker[];
  throttles?: SessionThrottle[];
  phases?: SessionPhase[];
  phaseIterations?: PhaseIterations;
  phaseLoopbacks?: PhaseLoopback[];
  startedAt: Date;
  updatedAt: Date;
  /**
   * ISS-6005: when the session RECORD was last mutated in its serving store —
   * the row-mutation clock behind the Sessions list's `Updated` column.
   *
   * ⚠️ Distinct from {@link updatedAt}, which is NOT a row-mutation time: the
   * cloud projects it from `session_detail.session_updated_at`, the
   * harness-reported recompute stamp bumped by desktop OTEL ingest / enrichment
   * / sync bookkeeping. `recordUpdatedAt` is DB-maintained:
   *  - cloud producer: `GREATEST(session_detail.updated_at,
   *    artifacts.updated_at)` — both Prisma `@updatedAt` columns, so it
   *    advances on sync writes AND on parent-row mutations (a status edit, and
   *    the forward-looking comment/tag cases) that never touch the detail row;
   *  - desktop local producer: the local `sessions.updated_at` column, which
   *    desktop writes bump on every row mutation (status, billing-mode heal,
   *    PR-link maintenance), i.e. the same claim against the local store.
   *
   * Optional + additive: a version-skewed producer that omits it degrades to an
   * empty `Updated` cell — consumers must NOT substitute {@link updatedAt} or
   * {@link lastActivityAt}, which answer different questions.
   */
  recordUpdatedAt?: Date;
  /**
   * PLN-1034: genuine-activity timestamp (latest real agent event, floored at
   * startedAt). Always populated for list rows — the default Sessions sort.
   */
  lastActivityAt: Date;
  endedAt: Date | null;
  awaitingInputSince: Date | null;
  /**
   * FEA-3479 (PRD-536 G1): when the cloud last persisted (upserted) this
   * session's metadata from a desktop sync. Written on every upsert
   * (SessionDetail.lastSyncedAt) but previously never served. Lets a lag-aware
   * UI show "synced Xs ago" per session and, together with
   * `computeTarget.lastAgentSessionSyncAt`, distinguish a session that is fresh
   * from one whose target has synced more recently than this row. Present on
   * cloud list/detail rows (the column is non-null with a `now()` default) and
   * on the local surface (the record's own `updatedAt`). Additive + optional so
   * a version-skewed producer that omits it degrades safely; consumers must
   * normalize a missing/`undefined` value rather than assume a `Date`.
   */
  lastSyncedAt?: Date;
  /**
   * FEA-3479 / PRD-536 G1 (Phase 3): the single session-level transcript verdict
   * (syncing / stale / synced / failed(-permanent) / never-expected), derived
   * cloud-side from the per-file `transcripts[]` availability states via
   * `deriveTranscriptDisposition`. Promoted onto the LIST item (not detail-only)
   * so a Sessions LIST row can render the same freshness affordance the detail
   * Properties panel does (`getSessionSyncStatus`) without a per-row detail
   * fetch. Additive + optional: a producer that doesn't compute it omits the key,
   * and the affordance degrades to the `lastSyncedAt` freshness label alone
   * rather than fabricating a "synced" verdict.
   *
   * ISS-4647: the desktop LOCAL list is now a producer too — it derives the same
   * verdict from its local `transcript_sync_state` rows via a bounded per-page
   * lookup. It reports the key ONLY when the metadata lane is already caught up:
   * while the session is still in the local sync outbox it is not in the cloud at
   * all, so the blob verdict is subsumed by that stronger statement and
   * publishing it would let a consumer narrow the disclosure to "just the
   * transcript". A local session with no transcript row still omits the key.
   */
  transcriptDisposition?: TranscriptDisposition;
  /**
   * ISS-9884: the terminal skip reason that PRODUCED
   * {@link transcriptDisposition}, when one did — `null`/omitted otherwise.
   *
   * The disposition alone stopped being sufficient when a third reason mapped
   * onto `failedTransient`. An ordinary retryable upload failure (the desktop
   * re-queues it with backoff) and an `environment_unavailable` give-up (the
   * lane STOPPED attempting, on a file presumed present) reach the same verdict
   * and are two different sentences to a user — "Sync failed, retrying" versus
   * "Upload paused". Without this field every renderer keyed on the disposition
   * alone states the wrong one of the two.
   *
   * Carried as an ADDITIVE OPTIONAL field rather than as a new
   * `TranscriptDisposition` member on purpose: an old client ignores an unknown
   * extra key, whereas an unknown disposition would degrade to NO badge at all
   * (every lookup in `session-sync-status.ts` is a `Record` returning `null`)
   * and to `pending: false` in `reconcileCloudSyncState`. A producer that does
   * not compute it omits the key, and the consumer renders the plain
   * disposition copy — the pre-ISS-9884 behavior.
   */
  transcriptDispositionReason?: TranscriptSkipReason;
  /**
   * FEA (PRD-536 E6): per-row local-vs-cloud sync disclosure. `pending` = this
   * session is still in the local sync outbox (un-acked by the server), so its
   * cloud copy may be missing or behind; `synced` = the cloud is caught up for
   * this row (no un-acked outbox entry, or the row was read from the cloud
   * store). ISS-11427: a desktop-local row may also read `dead_letter` (the
   * sync lane set it aside and will retry it) or `abandoned` (no path in the
   * running lane can reach it); the cloud never stamps either. Distinct from the
   * RESPONSE-level `readSource`, which stamps the whole list with which store
   * produced it and cannot distinguish two local rows.
   * Additive + optional: a producer that doesn't compute it omits the key, and
   * consumers treat a missing/`undefined` value as "unknown — render no per-row
   * disclosure" rather than assuming `pending`.
   */
  cloudSyncState?: AgentSessionCloudSyncState;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * ISS-12260: `null` when `session_detail.estimated_cost` is NULL (never
   * priced); a stored `0` is served as `0`. `null` rather than an omitted key
   * because installed Desktop builds do arithmetic on this field
   * (`Math.max(estimatedCost, 0.01)` in the synthesized activity strip), where
   * `null` behaves as the `0` they used to receive and `undefined` is `NaN`.
   */
  estimatedCost: number | null;
  billingMode?: string | null;
  agentCount: number;
  toolUseCount: number;
  // ISS-5801: derived component invocations (tools/skills/slash commands/
  // subagents/hooks) — a substantive-work signal beside toolUseCount. Optional
  // because this shape crosses a version-skew boundary (an older server omits
  // it); readers coalesce absent → 0.
  componentInvocationCount?: number;
  errorCount: number;
  baseBranch: string | null;
  sourceArtifactId: string | null;
  sourceArtifact?: AgentSessionSourceArtifactSummary | null;
  sourceLoopId: string | null;
  /**
   * @deprecated Read `assignee`. A compatibility alias of `assignee`, kept for
   * version-skewed web, Desktop and MCP clients that read it as the Owner
   * (ISS-12585). The cloud API fills it from the artifact assignee; the
   * recording user it used to carry (`session_detail.user_id`) is retired.
   * ISS-12613 removes it, not before 2026-11-06.
   */
  user: BasicUser | null;
  computeTarget: AgentSessionComputeTargetSummary;
  project?: AgentSessionProjectSummary | null;
};

export type AgentSessionListResponse = {
  /** Confirms the requested component family was applied; absent on older APIs. */
  componentScope?: string;
  items: AgentSessionListItem[];
  total: number;
  viewerScope: AgentSessionViewerScope;
  /**
   * FEA-3284: how many idle ("phantom" / 0-turn / 0-token / 0-tool-use)
   * sessions match ALL of the current filters (facets + date window) EXCEPT the
   * quality filter — i.e. the rows the `quality=substantive` view hides (the
   * default `quality=all` view returns every session). Surfaces an accurate idle
   * count alongside the Substantive · Idle · All quality segment (FEA-4145, which
   * superseded the old "… hidden · Show" reveal). Omitted (treated as 0) by
   * producers/wire versions that don't compute it. When the list is already
   * showing `quality=all`, the hidden set is empty, so this is 0.
   */
  idleCount?: number;
  /**
   * FEA-3120: which store produced these rows — `local` (desktop SQLite via IPC),
   * `cloud` (synced cloud state via `apps/api`), or `fallback` (degraded/empty
   * best-effort). Populated at the read boundary in each data source, not by the
   * DB query. Optional so older/wire producers stay compatible; consumers treat
   * an absent value as "unknown source" and render nothing rather than guess.
   */
  readSource?: ReadSource;
  /**
   * ISS-9555: which page this response actually served — the limit and offset the
   * producer honoured, beside the offset that was asked for.
   *
   * Every host used to re-derive the rendered page from its OWN request plus
   * `total`, which is several independent pieces of clamping arithmetic kept in
   * agreement by hand; when one of them disagreed with the rows in hand, the
   * footer named a page the reader was not looking at. With this present the
   * position is read, not re-derived.
   *
   * OPTIONAL because it is additive on a version-skewed wire, and because not
   * every producer path performs a read: an older `apps/api` or Desktop build
   * omits it, and a consumer that finds it absent derives in place exactly as it
   * did before — it must NOT re-issue the read to go looking for one, because
   * Sessions has no unpaginated mode to fall back to (the arm that makes
   * Branches' `getBranchListWithServerFallback` legitimate and would be a second
   * request for nothing here).
   */
  pageInfo?: AgentSessionListPageInfo;
};

export type AgentSessionDetail = AgentSessionListItem & {
  metadata: JsonObject | null;
  /**
   * ISS-7427: what evidence backs the numbers in THIS response, as distinct from
   * what the response displays.
   *
   * The detail read has two independent producers and neither gates the other,
   * so a session whose main transcript is terminally absent still serves a
   * complete set of headline numbers. Without this field that session is, from
   * the response alone, indistinguishable from one whose numbers are backed by a
   * readable transcript — which is how a "216 events" heading came to sit above
   * a panel saying "Transcript not archived".
   *
   * OPTIONAL because it is additive on a version-skewed wire: an older `apps/api`
   * omits it, and a client that cannot tell must fall back to disclosing NOTHING
   * rather than guessing a state. `undefined` therefore means "this server does
   * not classify", never "main is readable" — do not default it to a verdict.
   */
  evidenceCoverage?: SessionEvidenceCoverage;
  /**
   * PLN-2061 M5: targets this session's run touched in repositories the
   * organization does not track, deduplicated and in a stable order. OMITTED,
   * never null or empty, when there are none or the read of them failed —
   * additive on a version-skewed wire, so an older `apps/api` and a
   * desktop-local read both read as "none".
   */
  untrackedRepositoryTargets?: SessionUntrackedRepositoryTarget[];
  /**
   * ISS-7516: the data-sync level the recording machine reported on its MOST
   * RECENT sync of this session. Not the reader's level and not the org's — the
   * producing device's, which is the one that decides whether this session's
   * transcript is queued (`dataSyncLevelAllowsTranscripts`).
   *
   * READ THE TENSE. This is "the level as of the last sync that reported one",
   * NOT "the level in force when the session ran". The write is last-write-wins
   * per session row, so a later incremental resync — or a backfill after the
   * user changes their level — restamps it. The two readings coincide for a
   * session whose level never moved, which is the common case, and diverge
   * exactly when it did. A consumer must therefore treat this as a statement
   * about the DEVICE's current posture, not as a historical fact about the run,
   * and must not pair it with a claim that only record-time evidence could
   * support. Whether the column should instead be write-once is an open
   * question raised on ISS-7516 rather than decided here.
   *
   * This is what lets a transcript's absence be told apart from a transcript's
   * DELAY. On any level but `full` the desktop never queues one, so the panel's
   * "It'll show up here once the source machine uploads it" was a statement the
   * source machine had already decided not to honour.
   *
   * OPTIONAL because it is additive on a version-skewed wire, and because the
   * column is NULL for every session synced before this field shipped.
   * `undefined` therefore means "this server, or that desktop build, does not
   * report a level" — NEVER a level itself. Do not default it: defaulting to
   * `metadata` stamps the never-expected note over every session on a lagging
   * deploy, and defaulting to `full` silently disables the disclosure while
   * reporting it on. A consumer that cannot tell must render what it renders
   * today.
   *
   * NOTE (privacy): this publishes a per-device privacy setting to every reader
   * of the session, which is org-scoped. PR #5713 escalated exactly that as a
   * product question rather than taking it; it is taken here on the operator's
   * instruction and is called out in the PR body rather than buried.
   */
  dataSyncLevel?: DataSyncLevel;
  sourceArtifactId: string | null;
  sourceLoopId: string | null;
  /**
   * ISS-7229: Claude Code's own `result.total_cost_usd` (PRD-538). NOT our
   * derived `estimatedCost` — the two routinely disagree, which is the drift
   * this field exposes.
   *
   * `null` whenever Claude reported nothing, the COMMON case: since ISS-7229 the
   * figure comes from the desktop's OTel capture, which is gated on a Labs
   * setting and so reaches a minority of sessions. Consumers must render that
   * absence AS absence — substituting `estimatedCost` publishes our estimate
   * under Claude's name, and `0` asserts a true-zero never measured.
   */
  authoritativeCostUsd?: number | null;
  tokenUsageByModel: SyncedAgentSessionTokenUsage[];
  attribution: SyncedAgentSessionAttribution | null;
  agents: SyncedAgentSessionAgent[];
  /**
   * ISS-6890: present ONLY when this read could not parse the whole persisted
   * agent roster, so `agents` is not the whole population.
   *
   * ABSENCE is the only encoding of "the roster is whole", so a producer that
   * predates this field — or the desktop's local `mapDetail`, which reads its own
   * rows and has no such blob — degrades correctly to the complete reading. It is
   * a nested OBJECT rather than a bare nullable count for the same reason
   * {@link eventsTruncated} is `true`-or-absent: one truthy predicate
   * (`if (detail.rosterIncomplete)`) has to catch EVERY incomplete case. A bare
   * `unreadableAgents?: number | null` would have made the worst case — an
   * unreadable blob, count unknown — the one that reads as complete under
   * `!= null`, `??`, and plain truthiness, which is the false-completeness this
   * field exists to remove.
   *
   * `unreadableAgents` is how many stored members were lost, or `null` when the
   * stored blob was not a readable array at all and the number is genuinely
   * unknown — never 0, which would claim a whole roster.
   *
   * A consumer must not present `agents` as the whole roster while this is
   * present — in particular must not render a "no agent records were captured"
   * empty state, which is the contradiction against
   * {@link AgentSessionListItem.agentCount} that this field makes visible rather
   * than plausible.
   */
  rosterIncomplete?: { unreadableAgents: number | null };
  events: SyncedAgentSessionEvent[];
  /**
   * ISS-5075: `true` when `events` is an intentionally partial, chronological
   * PREFIX — the stored stream exceeded the detail read's row ceiling
   * (`SESSION_DETAIL_EVENT_MAX_ROWS`). `turnItems` derives from that same
   * prefix, so this one flag describes both; a consumer must not
   * present the trace as the whole run when it is set. ABSENCE is the only
   * encoding of "complete", so a producer that never truncates (a client
   * predating this field) degrades correctly, and typing it `true`-or-absent
   * keeps a serialized `false` from becoming a third state every reader has to
   * interpret.
   *
   * ISS-5407: the desktop's local `mapDetail` is a producer too, and its scope is
   * WIDER than the cloud's. The cloud reads every summary field off a persisted
   * column, so there the cap trims only the `events` relation. Desktop has no such
   * columns — it folds them out of the rows it read — so on that producer this
   * flag ALSO covers the event-derived trace shape: `span`, `activityBuckets`,
   * `phases`/`phaseIterations`/`phaseLoopbacks`, `throttles`, `markers`, and the
   * `tracePhaseSources`/`throttleSources`/`correctionSources` arrays all describe
   * the prefix when it is set.
   *
   * ISS-5636: read that as a ONE-WAY implication, because it is one. Set, those
   * fields describe a prefix; ABSENT, they are not thereby whole-run. The trace
   * SOURCE arrays carry their own caps that this flag neither observes nor
   * reports — `SESSION_TRACE_SOURCE_LIMITS` bounds each of
   * `tracePhaseSources`/`throttleSources`/`correctionSources` at 100 rows and then
   * trims the three to a 64 KB aggregate budget — and
   * `phases`/`phaseIterations`/`phaseLoopbacks`/`throttles` are folded from those
   * trimmed arrays. ISS-6851: `markers` belongs in that set too — the desktop
   * producer slices it to 500 rows before sync, a row cap of its own that the 64
   * KB budget deliberately does not cover and that this flag does not report
   * either. So a session holding 101 phase-source events inside a raw
   * stream that never reached the row ceiling yields an incomplete
   * `phaseIterations` with this flag absent. Those cap outcomes are NOT
   * propagated today; a consumer that needs them must not infer them from here.
   *
   * The two scalars whose completeness IS reported per derivation are
   * {@link autonomyTruncated} and {@link steeringEpisodesTruncated}, which is
   * also how a consumer tells the wider desktop scope apart from the cloud's
   * narrow one.
   *
   * The fields a reader would compare against ANOTHER surface are deliberately
   * NOT in that widened set. `toolUseCount`/`toolCallsTotal`/`errorCount` are
   * re-read from a store-side aggregate and `lastActivityAt` from the
   * denormalized `sessions.last_activity_at` column, so both producers report
   * those on the same whole-run basis — and the ISS-5075 axis extension in
   * `resolveSessionTimelineWindow`, which widens a truncated axis to
   * `endedAt ?? lastActivityAt`, keeps a bound the cap cannot collapse.
   */
  eventsTruncated?: true;
  /**
   * ISS-5636: `true` when {@link autonomy} was scored over the served event
   * PREFIX rather than the whole run.
   *
   * Scoped to that ONE scalar because completeness here is a property of a
   * derivation, not of a read. Autonomy is attributed across a merged
   * agent-activity stream — the session's parsed transcript messages and its
   * token events, both read UNCAPPED, plus the raw event rows, which the detail
   * read bounds — so a bounded read cuts the stream's tail and moves the span
   * the score is computed over. Only the desktop's local `mapDetail` sets it,
   * and only when {@link eventsTruncated} is set; the cloud reads the score off
   * a persisted column the cap never touches and leaves this absent.
   *
   * Absence means "this score describes the whole run", so a producer predating
   * this field (or one reading a persisted column) degrades correctly, and
   * `true`-or-absent keeps a serialized `false` from becoming a third state.
   *
   * Deliberately CONSERVATIVE in two ways, both toward over-hedging, which is
   * the safe direction — it never does the thing this field exists to stop
   * (present a prefix count as a whole-run fact). The desktop loader reads
   * `SESSION_DETAIL_EVENT_MAX_ROWS + 1` rows and folds over ALL of them while
   * `events` is trimmed back to the ceiling, so a session storing exactly
   * `MAX + 1` events gets a whole-run fold flagged as a prefix. And a HEADLESS
   * run with no captured prompt episodes scores a constant 100 by construction,
   * which no cap can move; telling that case apart from outside the deriver
   * would mean re-deriving it here.
   */
  autonomyTruncated?: true;
  /**
   * ISS-5636: `true` when {@link steeringEpisodes} was counted over the served
   * event PREFIX rather than the whole run.
   *
   * Reported separately from {@link autonomyTruncated} because the two scalars
   * genuinely disagree about their own completeness on reachable sessions, and
   * one flag over both would mislabel whichever it did not describe. Steering
   * episodes are grouped from HUMAN-turn timestamps, and where those come from
   * depends on the session:
   *
   * - A run launched headlessly has no human turns to count; its steering is
   *   fixed at `0` by construction from the harness entrypoint, so the row cap
   *   cannot move it and this stays absent.
   * - A session with a parsed transcript takes its human turns from
   *   `metadata.messages`, which the detail read never bounds, so the count is
   *   whole-run even past the ceiling and this stays absent.
   * - A transcript-less (hook-only) session falls back to matching human-input
   *   rows in the raw event stream, which IS the bounded read — that is the one
   *   case where the count describes a prefix, and the only case that sets this.
   *
   * Absence means "this count describes the whole run", on the same
   * `true`-or-absent encoding and for the same skew reasons as
   * {@link autonomyTruncated}.
   */
  steeringEpisodesTruncated?: true;
  /**
   * ISS-9857: the per-event cost points the DESKTOP-LOCAL producer attributed
   * to `turnItems`, present ONLY when {@link eventsTruncated} is set. A client
   * that pages past the prefix (`GET /agent-sessions/[id]/events`, or the
   * desktop's IPC twin) re-projects the union of prefix + pages through the same
   * projector the producer ran, and without these points that re-projection
   * would strip the cost badges the prefix rows already carried. Absent on the
   * cloud producer, which drops cost points under truncation anyway, and absent
   * on a complete stream, where no client re-projects. One small point per
   * token event, bounded by the producer's own token-event read.
   */
  tokenEventCostPoints?: TokenEventCostPoint[];
  turnItems?: TurnItem[];
  tracePhaseSources?: SessionTracePhaseSource[];
  throttleSources?: SessionTraceThrottleSource[];
  correctionSources?: SessionTraceCorrectionSource[];
  /**
   * FEA-3568: the raw activity-segment tiling replicated from the desktop
   * (`session_lis`), org-scoped via the SessionDetail join. Optional + additive —
   * a session synced from a pre-FEA-3568 desktop build (or before backfill)
   * carries none, and the surface degrades to the honest fallback rather than
   * fabricating attribution. Distinct from the derived per-phase `ActivitySegment`
   * read shape (FEA-2275, which aggregates FROM these rows); no UI in this feature.
   */
  activitySegmentRows?: SyncedActivitySegmentRow[];
  /**
   * ISS-10721: the session's activity-metrics rollup as the READ contract
   * exposes it — the autonomy band, the spend split across the three
   * attribution-confidence tiers, and the segment coverage counts.
   *
   * UNKNOWN IS NOT ZERO. Every field inside is nullable and `null` is the only
   * representation of "not computed": a session whose rollup never ran reads
   * `null` throughout, never `0` coverage and never the bottom band. The whole
   * key is OMITTED when nothing at all was measured, so a client cannot mistake
   * an all-`null` object for a rollup that ran and found nothing.
   *
   * The three spend figures partition the ATTRIBUTED spend only — out-of-segment
   * spend belongs to no confidence tier — so their sum is not the session's
   * total cost and must not be labelled as one.
   */
  activityMetrics?: SessionActivityMetricsRead;
  /**
   * ISS-10721: how complete the archived evidence behind this view is, in
   * bytes, as the cloud's own archive state reports it — the quantitative half
   * of the disclosure whose categorical half is {@link transcriptDisposition}.
   *
   * `archivedByteOffset` is the last VERIFIED byte offset across the session's
   * transcript files; `observedByteSize` is the size the recording machine last
   * reported for those same files. Both are `null` when no transcript row
   * exists, and the key is omitted entirely then — a `0` here would claim a
   * measured empty archive. `observedByteSize >= archivedByteOffset` is the
   * invariant; a client renders any shortfall as incomplete evidence, never as
   * an error.
   *
   * Both byte figures are ALL-OR-NOTHING over the session's `fileCount` rows:
   * `observedByteSize` is withheld unless every row reported a size, and
   * ISS-11089 did not change that (marisolashgrove, 2026-09-27: "we should not be
   * changing denominators for anything"). A denominator re-based on the rows
   * that happen to report would read as complete when it is not.
   *
   * What ISS-11089 added is two counts that say WHY a figure is withheld, which
   * a bare `null` never did. `reportingFileCount` is how many rows reported a
   * readable size, so the gap to `fileCount` is the number of missing operands.
   * `unrecoverableFileCount` is how many of `fileCount` files the desktop will
   * NEVER archive, having terminally skipped them for a hard reason — what tells
   * a permanent withholding from an in-flight one.
   *
   * IT COUNTS FILES, AND IT IS NOT A SHORTFALL IN EITHER BYTE FIGURE (review).
   * The ordinary unrecoverable file never reported a size, so it withholds
   * `observedByteSize` outright — and, never having completed, it contributes
   * `0` to `archivedByteOffset` too. A file that completed once and was later
   * hard-skipped carries its size, and the one write that produced it set the
   * offset to the same value, so it leaves the denominator whole and both
   * figures equal. On today's writer the two are therefore EQUAL whenever both
   * publish, whatever this count says: do not derive "how much is missing" from
   * their difference, and do not read equality as "nothing is missing". This
   * count is the only statement that a file will never be archived. Render it
   * beside the figures, never in place of them.
   *
   * Additive and OPTIONAL on the wire, both counts: an older API deployment
   * serves the pre-ISS-11089 three-key object to a newer client, so absence
   * means "not reported by this API", never `0`. A client that ignores the new
   * keys reads exactly the figures it read before.
   */
  transcriptArchiveProgress?: TranscriptArchiveProgress;
  /**
   * FEA-3779 / FEA-4238: `true` when `activitySegmentRows` is an intentionally
   * partial, start-ordered prefix rather than the whole stored tiling. It is
   * derived HERE, per read, from the detail select hitting
   * {@link MAX_STORED_ACTIVITY_SEGMENTS} (ISS-4541) — the same semantics as the
   * like-named sync field, but an independent derivation, NOT that wire value
   * relayed: nothing persists the wire signal.
   *
   * Optional + additive, and omitted/null is a DEFAULT, not an assertion: it is
   * read as complete so a session served before the read projection populated
   * this degrades to "complete" rather than fabricating truncation. It does not
   * establish completeness. Two stored shapes are genuinely partial and arrive
   * here unflagged — a pre-FEA-3779 tiling the desktop cut at its silent 500-row
   * assembly cap, and a chunked sequence whose tail has not landed (or never
   * will), since `persistSessionActivitySegments` applies chunk 0 and its
   * successors in separate transactions.
   *
   * ISS-9858: its one reader is the Session Timeline legend line
   * (`resolveTimelineTruncatedTilingLegend` in
   * `packages/app/agents/components/detail/session-timeline-coverage.ts`), which
   * discloses that later activity was not read. `projectActivitySegments` does
   * not forward it — that projection's only production caller,
   * `getPhaseTilingSpan`, reads the span bounds and nothing else, so the axis is
   * sized from the prefix while the legend says so. No shipped producer reaches
   * the ceiling today (the desktop omits an over-ceiling tiling rather than
   * sending a prefix), so this is a backstop disclosure, not a reachable state.
   */
  activitySegmentRowsTruncated?: boolean | null;
  /**
   * FEA-2275: the derived per-phase activity breakdown ({@link ActivitySegment}),
   * aggregated once in `@repo/lib` from `activitySegmentRows` + the session's
   * token events and forwarded identically by the cloud and desktop projections
   * so web and desktop render the same breakdown. Optional + additive — a
   * session lacking raw rows (pre-FEA-3568 desktop build / pre-backfill history)
   * omits it, and the renderer degrades to the honest single "Other /
   * unclassified" fallback rather than fabricating attribution.
   */
  activitySegments?: ActivitySegment[];
  /**
   * FR8 per-file transcript availability summary (FEA-2716 / PLN-1289). Always
   * includes the main transcript (as `missing` when it has no row yet), plus an
   * entry per subagent file — matching the read route's synthesis (PRD AC6).
   * Lets list/detail UIs show availability without minting a signed URL — the
   * read route does that on explicit access.
   */
  transcripts?: TranscriptAvailabilitySummary[];
  /*
   * `transcriptDisposition` (the session-level transcript verdict) now lives on
   * `AgentSessionListItem` (promoted for the Sessions LIST row affordance,
   * PRD-536 G1 Phase 3) and is inherited here. The detail service continues to
   * populate it from the same per-file `transcripts[]` fold
   * (`deriveTranscriptDisposition`).
   */
  /**
   * ISS-8427: EVERY branch this session touched, not the one
   * {@link AgentSessionListItem.branch} picked out of them.
   *
   * `branch`/`branchArtifactId` are single-valued and resolve by keeping the
   * LAST eligible link of an ordered scan, so a session that pushed five
   * branches and opened a PR from each served one branch name beside five PR
   * pills and a "Lines changed" figure summed across all five. This field is the
   * whole eligible set, so a reader is no longer shown a sixth of the answer.
   *
   * THE SCALAR'S ELIGIBILITY, widened by exactly one legacy case — never a
   * looser net. Only branches the session genuinely TOUCHED: a `session_branch`
   * link (which carries a `branchParticipation`) or an AUTHORED PR link. A
   * branch a transcript merely mentioned, or a PR the session only referenced or
   * reviewed, authored no branch and is absent here exactly as it is absent from
   * the scalar.
   *
   * The one addition is the PRE-COLUMN `session_branch` link: `branch_participation`
   * was added without a backfill, so a link written before it states its
   * participation only in metadata and reads as untouched to a column-only test.
   * Those rows are recovered here, which is why this set is a SUPERSET of the
   * scalar's population and `branch` is always a member of it. The widening is
   * confined to `session_branch` links on purpose: the metadata rule also maps a
   * `Reviewed` relation to a participation, so applying it to PR links would
   * admit the merely-reviewed PR both derivations exclude.
   *
   * ORDER is the link scan's `createdAt asc` — the order the session touched
   * them. It is deliberately NOT a ranking: which of a session's branches
   * matters most is a product question this field does not answer.
   *
   * The scalar pair is UNCHANGED and still served: this is additive, and a
   * client that reads only `branch` behaves exactly as before. `[]` is the
   * computed answer for a session that touched none; the key is OMITTED only by
   * a producer that does not compute it (the LIST projections do not), so a
   * consumer must read absence as "not computed", never as "none".
   */
  branches?: SessionBranch[];
};

export type AgentSessionUsageSummary = AgentSessionCostSplitFields & {
  /** Confirms the requested component family was applied; absent on older APIs. */
  componentScope?: string;
  viewerScope: AgentSessionViewerScope;
  totalSessions: number;
  /**
   * Earliest session start (ISO timestamp) across all matching sessions, or
   * null when none match. Together with `latestSessionAt`, describes the time
   * span the aggregate totals cover.
   */
  earliestSessionAt: string | null;
  /** Latest session start (ISO timestamp) across matching sessions, or null when none match. */
  latestSessionAt: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /**
   * FEA-3156 — delivery-summary metrics for the Sessions page top row, computed
   * over the SAME matched-session set as the totals above via the delivery-KPI
   * SSOT engine.
   *
   * OPTIONAL because only the cloud sessions-usage endpoint computes them (via
   * the merged-PR read layer). Surfaces without that backing (e.g. the desktop
   * local SQLite producer) omit them; the summary cards then fall back to the
   * "unavailable" placeholder rather than fabricating a value.
   *
   * `mergedPrCount` — count of merged PRs linked to the matched sessions
   * ("merged in range"). `null` when the matched set has NO merged PRs to count
   * (no data — never a fabricated `0`), so the PRs Shipped card renders the
   * neutral no-data state alongside its sibling delivery cards rather than
   * lying about having merged zero PRs (FEA-3574 review, whitlockk). A real, finite
   * count (>= 1) only when at least one merged PR was found; `undefined` when
   * the surface (e.g. the desktop local SQLite producer) does not compute it.
   */
  mergedPrCount?: number | null;
  /**
   * Median gross lines (additions + deletions) across those merged PRs. Null
   * when there are no merged PRs to measure; undefined when the surface does not
   * compute it.
   */
  medianPrSize?: number | null;
  /**
   * ISS-4667: merged gross LINES ÷ token cost across the matched sessions —
   * LOC/$, higher is better, no divide-by-1000 and never inverted. Null when
   * there are no merged lines to count or no cost to divide by; undefined when
   * the surface does not compute it.
   *
   * `mergedKlocPerDollar` is DEPRECATED (ISS-4667) — the KLOC-unit predecessor,
   * still emitted alongside it (LOC/$ ÷ 1000) for one release so an
   * already-installed pre-ISS-4667 Desktop keeps reading a value. New consumers
   * must read `mergedLocPerDollar`, or resolve the alias through
   * `resolveLocPerDollar` (which scales it into LOC/$), never render it directly.
   */
  mergedLocPerDollar?: number | null;
  /**
   * ISS-9848: WHICH ratio `mergedLocPerDollar` is — the numerator and the
   * denominator the producer actually divided, so a version-skewed client is
   * TOLD rather than left to assume. Present on any producer that computes the
   * ratio at all, including when the value itself is `null` (the caption is
   * rendered either way); ABSENT — never `null` — from a producer that does not
   * compute the metric, per the cross-repo omit-don't-null rule.
   *
   * A consumer must read an UNRECOGNIZED value as "a basis this build cannot
   * describe" and coarsen, never as the basis it happens to know: a newer server
   * can send a member this build never compiled against, and that is precisely
   * the skew this field exists to make visible.
   * `resolveMergedLocPerDollarHow` / `resolveMergedLocPerDollarWhat` are the
   * canonical folds; absence resolves to the pre-ISS-9848 sentences.
   *
   * TYPED `string`, NOT `MergedLocPerDollarBasis`, and that is the whole point
   * (whitlockk review on #6929). This is the CONSUMER-side shape of an open response
   * contract: the value reaches `api.get` as JSON from a server that may be
   * newer than this build, so the one member this build compiled against is a
   * fact about the build, not about the wire. Declaring the closed union here
   * would let a typed consumer write an exhaustive `switch` over that single
   * member, satisfy `tsc`, and skip the generic arm — reintroducing the exact
   * version-skew defect the field exists to close, this time with the compiler
   * vouching for it. The closed `MergedLocPerDollarBasis` union is retained for
   * SERVER-SIDE EMISSION (`toMergedLocPerDollarBasis` in
   * `apps/api/app/agent-sessions/service/loc-per-dollar-basis.ts`), where the
   * producer genuinely does know every member it can publish.
   */
  mergedLocPerDollarBasis?: string;
  /**
   * ISS-7705: whether the cost denominator behind `mergedLocPerDollar` actually
   * covers the merged work in its numerator, and the populations that decided
   * it. Present only on a producer that measured it AND only when there is a
   * ratio to gate (at least one merged PR); ABSENT — never `null` — otherwise,
   * so an older client's `undefined` check and the cross-repo omit-don't-null
   * rule agree.
   *
   * A consumer that renders the ratio must treat any non-`complete` state as
   * "do not state this number": the two sides are aggregated from independently
   * scoped reads, and every uncovered numerator session pushes the published
   * value UP. See `apps/api/app/agent-sessions/service/loc-per-dollar-coverage.ts`.
   */
  mergedLocPerDollarCoverage?: LocPerDollarCoverage;
  mergedKlocPerDollar?: number | null;
  /**
   * ISS-11117: Pensero delivery points per dollar over the SAME denominator
   * {@link mergedLocPerDollar} divides — the total estimated cost of the
   * matched sessions — so the two ratios describe one population and only the
   * numerator differs.
   *
   * A SIBLING FIELD, deliberately, and not a numerator swapped under
   * `mergedLocPerDollar`. That field's basis contract
   * ({@link mergedLocPerDollarBasis}) warns that moving its numerator while its
   * basis member still says `merged_lines_over_total_cost` re-creates the exact
   * version-skew defect the discriminator exists to close. Publishing the
   * points ratio under its own name leaves every existing member true, and an
   * old client that has never heard of this field keeps rendering the LOC card
   * it already renders.
   *
   * Additive and optional, and its absence is MEANINGFUL rather than merely
   * version skew: a producer predating the field omits it, and so does a
   * current producer whose reader is outside the Pensero display rollout, whose
   * sessions touched no branch with delivery evidence, or whose delivery read
   * failed. All of those mean the same thing to a consumer — there is no
   * Pensero numerator here, render LOC/$ unchanged — which is why one absent
   * field serves them all.
   *
   * A PRESENT `0` is a measured zero and renders as one. Never serialized as
   * `null` when absent, per the cross-repo omit-don't-null rule.
   */
  penseroPointsPerDollar?: number;
  byUser: AgentSessionUsageByUser[];
  /** Optional query-time lens that splits each session across linked branches. */
  byBranch?: AgentSessionUsageByBranch[];
  /** Optional query-time lens that re-keys trusted current-PR branch shares. */
  byPr?: AgentSessionUsageByPr[];
  /**
   * Per-model token/cost breakdown grouped by EVERY model a session used
   * (primary plus any secondary/subagent model in `tokenUsageByModel`). This is
   * a cost-attribution lens — a subagent model's tokens must show under that
   * model — so it intentionally does NOT match the single primary model painted
   * in the Sessions table's Model column. Do NOT source the Model filter facet
   * from this; use `modelFilterOptions` (FEA-4303).
   */
  /**
   * ISS-8554 O2 — OPTIONAL, and the TypedSQL producer omits it entirely.
   *
   * It is the only consumer of `agent_session_token_usage` on the Sessions
   * usage path and it renders nowhere: the Model FACET reads
   * `modelFilterOptions` (grouped on the primary displayed model, FEA-4303),
   * and ISS-10733 deleted the last component that read this field, so nothing
   * renders it today.
   *
   * Optional rather than deleted because the live producer still emits it;
   * absence here means "this producer does not compute it", never "no models
   * were used".
   */
  byModel?: AgentSessionUsageByModel[];
  /**
   * FEA-4303: options for the Model filter facet, grouped by the PRIMARY
   * displayed model (`SessionDetail.model`) — the exact value the Sessions table
   * paints in its Model column. The Model filter predicate matches this same
   * primary field, so selecting an option only ever returns rows whose visible
   * Model equals the selected value (filter, options, and column share one
   * vocabulary). Optional/additive: a producer that does not compute it leaves
   * it undefined, and the facet falls back to no options rather than the
   * mismatched `byModel` list.
   */
  modelFilterOptions?: AgentSessionModelFacetOption[];
  byHarness: AgentSessionHarnessBreakdown[];
  /** Per-repository breakdown — sources the Repository filter facet. */
  byRepository: AgentSessionRepositoryBreakdown[];
  /**
   * ISS-5355: per-project breakdown — sources the Project filter facet. A
   * session belongs to a project when it LINKED a document in it (ISS-5236's
   * "linked artifacts"), so a session that linked nothing contributes no row
   * here. There is deliberately no inferred repository→project fallback.
   *
   * Optional/additive: only the cloud usage endpoint computes it. The desktop
   * local producer cannot resolve cloud projects, so it omits the field and the
   * Project facet is not offered there at all — an absent field yields no
   * options rather than an empty-looking facet.
   */
  byProject?: AgentSessionProjectFacetOption[];
  lastSyncTargets: AgentSessionLastSyncTarget[];
  /**
   * ISS-5809 — server-computed period-over-period movement for the comparable
   * summary cards. Present only when the caller opts in (`comparison=prior`) AND
   * the active range has a prior window; a producer that computes no comparison
   * (the desktop local SQLite source) omits it and the cards render no chip,
   * exactly as they do today. Omission semantics live in
   * `agent-session-usage-comparison.ts`.
   */
  comparison?: AgentSessionUsageComparison;
};

export type AgentSessionAnalytics = {
  viewerScope: AgentSessionViewerScope;
  byTool: AgentSessionToolBreakdown[];
  byAgentType: AgentSessionAgentTypeBreakdown[];
  /**
   * ISS-6890 (#5209 review): present ONLY when {@link byAgentType} is a lower
   * bound because some session's persisted roster could not be fully read.
   * Absence is the only encoding of "complete"; semantics and the
   * omit-never-null contract live on
   * {@link AgentSessionAgentRosterIncompleteness}.
   */
  agentRosterIncomplete?: AgentSessionAgentRosterIncompleteness;
  byRepository: AgentSessionRepositoryBreakdown[];
  byProject: AgentSessionProjectBreakdown[];
  /** Optional query-time lens that splits each session across linked branches. */
  byBranch?: AgentSessionUsageByBranch[];
  /** Optional query-time lens that re-keys trusted current-PR branch shares. */
  byPr?: AgentSessionUsageByPr[];
};

/**
 * Viewer scope values accepted by agent-session list, usage, analytics, and
 * export routes. Use these const members instead of raw string literals so
 * route validators, services, and tests cannot drift.
 */
export const AgentSessionViewerScope = {
  Organization: "organization",
  Self: "self",
  Team: "team",
} as const;
export type AgentSessionViewerScope =
  (typeof AgentSessionViewerScope)[keyof typeof AgentSessionViewerScope];

export const AGENT_SESSION_VIEWER_SCOPE_OPTIONS = [
  AgentSessionViewerScope.Self,
  AgentSessionViewerScope.Organization,
  AgentSessionViewerScope.Team,
] as const;

/**
 * Combined list + usage read (FEA-4157) — the Sessions counterpart of
 * `BranchesPageData`. The Sessions screen mounts the session table and its
 * summary KPI cards together on every load, so a single `pageData` read lets a
 * data source serve both from ONE shared scan (the desktop-local metadata-only
 * usage aggregate + the paginated list) instead of the table and the cards each
 * issuing an independent read of the same underlying rows. The usage aggregate
 * is what backs the prop-driven `SessionsSummaryCards`, mirroring how
 * `BranchesPageData.analytics` backs `BranchesSummaryCards`.
 */
/**
 * FEA-4177 — independent failure domains. The `usage` half is best-effort: a
 * data source that reads the two halves independently (the HTTP source's two
 * concurrent requests; the desktop combined read's two SQL folds) must NOT let a
 * usage-read failure reject the whole page-data read and blank the list. On a
 * usage failure it resolves the list with `usage` omitted and `usageError: true`
 * so the summary cards degrade to their own error state while the table still
 * renders (and vice-versa: a list failure rejects, since the table cannot render
 * without it). A source that reads both from one atomic scan (an empty/disabled
 * guard) still populates `usage` and leaves `usageError` absent.
 */
export type AgentSessionsPageData = {
  list: AgentSessionListResponse;
  usage?: AgentSessionUsageSummary;
  usageError?: boolean;
  /**
   * ISS-4483 (review cid 3679616168, whitlockk): set alongside `usageError` ONLY when
   * the usage-half failure was a TRANSIENT local db-host lifecycle error (the
   * child crash-looping / restarting mid-backfill). When the list wins the race
   * and the usage aggregate rejects transiently, the combined read still RESOLVES
   * (list rendered, usage omitted), so the renderer's query never sees a rejection
   * to retry — this marker lets the summary cards route to the quiet reconnecting
   * surface (and drive a bounded refetch) instead of the fatal dash, matching the
   * transient-list path. Additive and optional: an older renderer ignoring it
   * still sees `usageError: true` and degrades exactly as before. A non-transient
   * (genuine) usage failure leaves it absent so the cards stay honestly errored.
   */
  usageErrorTransient?: boolean;
};

/**
 * ISS-5090 / ISS-8005: how many characters of the ingest ack's `detail`
 * diagnostic the desktop echoes into its gateway log.
 *
 * Shared single source of truth, for the same reason as
 * {@link MAX_SYNCED_COMPONENT_USAGE}: the cloud sizes the field path it puts in
 * `detail` against this budget, and the desktop slices `detail` to it before
 * logging. A value spelled separately on each side can drift, and the desktop's
 * slice emits NO truncation marker — so a shorter cap would silently leave a
 * bare path prefix that names a field which is not the one that failed, which is
 * exactly the ambiguity ISS-8005 exists to remove.
 */
export const SYNC_ACK_DETAIL_MAX_CHARS = 120;

/**
 * ISS-8427: ONE branch a session touched, as an addressable destination.
 *
 * `branchArtifactId` carries the same OPAQUE-route-token contract as
 * {@link AgentSessionListItem.branchArtifactId} — the producer owns its format
 * (the cloud emits the Branch artifact id, the desktop its own encoded id), so
 * a consumer hands it to that surface's href builder and never parses it.
 *
 * A member always carries both a resolved `name` and an id: an entry that could
 * not resolve a branch NAME would render as an unnamed link, so the derivation
 * drops it rather than serving it.
 */
export type SessionBranch = {
  name: string;
  branchArtifactId: string;
};
