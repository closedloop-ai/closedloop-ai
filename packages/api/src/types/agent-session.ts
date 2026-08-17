import { z } from "zod";
import type { ActivityBucket } from "./activity-bucket";
import type { AgentSessionCloudSyncState } from "./agent-session-cloud-sync-state-constants.js";
import type { AgentSessionCostSplitFields } from "./agent-session-cost-split";
import type {
  AgentSessionModelFacetOption,
  AgentSessionProjectFacetOption,
} from "./agent-session-facet-options";
import type {
  ToolCallDetailState,
  ToolCats,
  ToolItem,
} from "./agent-session-tool-call.js";
import type {
  AgentSessionAgentTypeBreakdown,
  AgentSessionProjectBreakdown,
  AgentSessionRepositoryBreakdown,
  AgentSessionToolBreakdown,
  AgentSessionUsageByBranch,
  AgentSessionUsageByPr,
} from "./agent-session-usage-breakdown";
import type { AgentSessionUsageComparison } from "./agent-session-usage-comparison";
import type { JsonObject, JsonValue } from "./common.js";
import type { TranscriptAvailabilitySummary } from "./desktop-transcripts.js";
import type { DocumentType } from "./document.js";
import type { ReadSource } from "./read-source.js";
import type {
  SyncedArtifactRef,
  SyncedSessionPrRef,
} from "./session-artifact-link.js";
import type { SyncedComponentVariantsEnvelope } from "./synced-component-content.js";
import type { TokenEventProvenanceFields } from "./token-cost-provenance.js";
import type { TranscriptDisposition } from "./transcript-disposition-constants.js";
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
 * `externalId`, `componentKind`, `componentKey`, `name`. These feed the
 * org-identity slug and now ride into the `search_document` route metadata
 * (`slug`, `entity_subtype`, `title`), so unlike `content` they were previously
 * unbounded on the wire: a burst of components with pathologically long keys
 * could inflate one query's route metadata into tens of MiB. 512 chars
 * comfortably covers a real component name/key/kind while capping abuse. The
 * cloud ingest Zod schema rejects anything larger; a slug/route built from these
 * fields therefore has a bounded length.
 */
export const SYNCED_COMPONENT_IDENTITY_MAX_CHARS = 512;

/**
 * Maximum number of `SyncedComponentUsage` entries allowed per session payload.
 * Mirrors the `MAX_SYNCED_ARTIFACT_REFS` pattern to prevent oversized batches.
 *
 * Shared single source of truth (FEA-3322): the cloud ingest Zod schema rejects
 * anything larger (`.max(...)`) and the desktop slices per-session usage to this
 * cap before sending. Both sides MUST reference this constant — if they drift, a
 * session whose component usage exceeds the cloud cap fails validation as
 * `session_invalid` and the entire session silently never syncs (total loss).
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
   * FEA-2923: the component's content hash when this usage was recorded
   * (hash-at-invocation). Additive/optional — omitted/null when the definition
   * content had not been collected. Lets the cloud attribute each session/branch
   * to the definition revision that ran.
   */
  componentVersionHash?: string | null;
};

export const DESKTOP_AGENT_SESSIONS_SOCKET_EVENT =
  "desktop.agent-sessions" as const;
export const DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY =
  "desktop-agent-session-sync" as const;
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
 * FEA-2718 (PLN-1294) bumps this 1 → 2. Dropping `summary`/`data` from the event
 * schema is itself backward-compatible (a stale desktop's turn text is stripped
 * on ingest and never persisted), but the plan requires the bump so a
 * desktop/API deploy skew is loud and immediate: the API pins acceptance to this
 * literal, so a desktop still on v1 is rejected until it updates rather than
 * silently syncing the pre-FEA-2718 shape. The internal fleet updates in lockstep
 * with the API deploy. The cloud transcript archive (FEA-2717) is the sole source
 * of turn/tool detail; the DB keeps only columnar event metadata.
 *
 * The value 2 is now free: the event-fragment transport that previously used a
 * separate `schemaVersion` 2 was retired in FEA-2718 (slim events always fit one
 * envelope), so there is no collision. The desktop mirror of this constant in
 * `apps/desktop/src/main/agent-session-sync-contract.ts` must move in lockstep.
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

/**
 * Compatibility tombstone emitted by the removed Session Trace state-action
 * endpoint for stale browser bundles that still call the old route.
 */
export const AgentSessionStateActionRemoval = {
  Message: "Agent session state actions are no longer supported",
  Code: "agent_session_state_actions_removed",
} as const;
export type AgentSessionStateActionRemoval =
  (typeof AgentSessionStateActionRemoval)[keyof typeof AgentSessionStateActionRemoval];

/**
 * The PROJECTED detail state of a session — a DIFFERENT axis from a session's
 * lifecycle status, not that enum renamed. Do not conflate them or "unify" them
 * by aliasing. Full rule: the "Session State" section of the root `AGENTS.md`.
 *
 * Status is the lifecycle (`active` / `inactive` / `error`, `SESSION_STATUS` in
 * `@repo/api/src/types/session-status`). This is a separate, richer value: it
 * carries members status has no equivalent for (PendingApproval, Blocked,
 * InReview, Running), and `toAgentSessionState` derives it from the status and
 * the session's own timestamps.
 *
 * There is no second axis. `toAgentSessionState` took a PR-outcome signal for
 * FEA-3551's rescue — an `abandoned` session read Completed once it shipped a
 * PR — which ISS-4654 made INERT and ISS-6588 removed outright along with the
 * retired-spelling branches that were its only reader. Do not reintroduce it as
 * a live input.
 *
 * A stored `SessionDetail.state` is honored when it parses, but that column is a
 * LEGACY compatibility input, not an actively persisted axis: the current sync
 * path has no `state` field and `toTraceDetailPatch` never writes it. No
 * exhaustive status→state mapper exists today, so adding a `SESSION_STATUS`
 * member does NOT fail `tsc` here — `toAgentSessionState` branches on a
 * free-form status string. Building that mapper is tracked on ISS-5592.
 */
export const AgentSessionState = {
  PendingApproval: "PENDING_APPROVAL",
  Blocked: "BLOCKED",
  InReview: "IN_REVIEW",
  Running: "RUNNING",
  Completed: "COMPLETED",
  /*
   * ISS-4654: a dedicated `AgentSessionState.Inactive` is RESOLVED AS NOT
   * NEEDED — not deferred, and not pending a rollout. `inactive` → `Completed`
   * is the CORRECT projection, never a placeholder: the two vocabularies answer
   * different questions. `SESSION_STATUS` is the stored LIFECYCLE of a row
   * (`active` / `inactive` / `error`); this is the OUTCOME the detail page
   * reports (did the run finish, or die). A finished-not-failed run IS
   * `Completed` in outcome terms, so adding an `Inactive` member would put a
   * lifecycle word into a vocabulary that does not speak lifecycle. Do not
   * "finish" this by adding one. (ISS-4586's original deferral cited a
   * version-skew crash on old Desktop builds; that concern is moot because
   * nothing new is emitted on the wire. The tolerance work shipped anyway in
   * #4630 and is worth keeping — a missing display-map entry now falls back
   * instead of crashing, which was a real latent bug on its own.)
   * FEA-4287: a terminal FAILURE outcome. Previously ERROR collapsed into
   * `Blocked`, so a failed session read "Blocked" on its detail page while the
   * Sessions LIST (which renders the raw `SESSION_STATUS`) correctly showed
   * "Failed". This member lets the detail projection preserve the same terminal
   * outcome the list renders. `Blocked` is reserved for genuinely nonterminal
   * blocked work that may resume.
   * ISS-4654: the sibling `Abandoned` member is RETIRED. ISS-4586 supersedes
   * FEA-4287's abandonment half — `abandoned` is not an outcome in the
   * running / finished / finished-with-error vocabulary, it is a finished run —
   * and the cloud backfill collapsed every such row to `inactive`, which already
   * projects to `Completed`. Nothing can reach the state any more, so emitting
   * it would be inventing an outcome the data no longer supports.
   */
  Error: "ERROR",
} as const;
export type AgentSessionState =
  (typeof AgentSessionState)[keyof typeof AgentSessionState];

/** Validator for persisted Session Trace workflow state values. */
export const agentSessionStateValidator = z.enum(AgentSessionState);

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
export const desktopAgentSessionsSyncResponseValidator = z
  .object({
    synced: z.literal(true),
    acceptedSessionIds: z.array(z.string()).optional(),
  })
  .strict();
export type DesktopAgentSessionsSyncResponse = z.infer<
  typeof desktopAgentSessionsSyncResponseValidator
>;

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
  FeatureDisabled: "feature_disabled",
  IngestionFailed: "ingestion_failed",
  InternalError: "internal_error",
  RateLimited: "rate_limited",
  TargetNotOwned: "target_not_owned",
  ValidationFailed: "validation_failed",
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
  estimatedCostUsd?: number;
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
  /** Optional bounded Session Trace metadata; omission preserves cloud values. */
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
   * FEA-3779: `true` when the session's raw activity tiling was truncated before
   * sync — because it exceeded either the row cap
   * ({@link MAX_SYNCED_ACTIVITY_SEGMENTS}) or the serialized-byte budget
   * ({@link MAX_SYNCED_ACTIVITY_SEGMENT_BYTES}), so `activitySegmentRows` carries an
   * intentionally partial (start-ordered) prefix rather than the whole tiling.
   * Optional + additive: omitted (falsy) means the tiling is complete.
   *
   * Status (be honest — do NOT over-read this field): this is a FORWARD-COMPATIBLE
   * WIRE SIGNAL, reserved for a follow-up consumer. The desktop PRODUCES it and the
   * cloud ingest schema VALIDATES it (`apps/api/lib/desktop-agent-sessions-schema`),
   * but it is NOT YET persisted to a column on the cloud `AgentSession` nor exposed
   * on any read-side API — so no consumer can currently branch on it. Shipping the
   * signal now (rather than after the reader) keeps the wire contract stable and
   * lets a partial tiling be BACKFILLED-correct the moment a consumer lands: wiring
   * persistence + a read projection is the follow-up that makes the
   * "distinguish partial from complete" capability real end-to-end. Until then the
   * value's only guaranteed effect is that the truncation is LOGGED at assembly
   * time (see `boundActivitySegmentsForSync`'s call site), so a partial tiling is
   * observable operationally, not silently dropped.
   */
  activitySegmentRowsTruncated?: boolean | null;
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
  schemaVersion: typeof AGENT_SESSION_SYNC_SCHEMA_VERSION;
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
 * Stable, additive identities carried from a transcript/DB source through the
 * shared detail projection. Timestamp ordinals disambiguate rows emitted at an
 * identical instant; producer ids are preserved when available so deep links
 * never have to infer a target from display text.
 */
export type TranscriptTurnIdentity = {
  eventId?: string;
  providerToolUseId?: string;
  agentId?: string;
  externalAgentId?: string;
  userTurnId?: string;
  timestamp?: string;
  timestampOrdinal?: number;
};

/**
 * ISS-5999: the bar shape lives in its own module now — see
 * `activity-bucket.ts`. Re-exported here so every existing consumer keeps its
 * `@repo/api/src/types/agent-session` import.
 */
export type { ActivityBucket } from "./activity-bucket";

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
 * FEA-3568 / FEA-3779: max raw activity-segment rows accepted per session on the
 * sync wire and emitted by the desktop payload assembly. Mirrors the `MAX_SYNCED_*`
 * bounding pattern; the desktop caps its assembly at this SAME value so a
 * pathological session never sends more rows than the schema accepts (an
 * oversized array is rejected wholesale, which would drop the whole tiling).
 *
 * This is a single SSOT constant, deliberately NOT an env knob: it bounds both
 * the desktop assembly cap AND the cloud ingest Zod `.max(...)` (and the Prisma
 * `take`), so cloud and desktop MUST agree on the exact value. An env-derived
 * bound could desync the two sides — the cloud would then reject payloads the
 * desktop considered valid (or vice versa). Tune it here, in one place, and both
 * surfaces move together.
 *
 * FEA-3779: raised from the original 500. That 500 was a bare magic number that
 * did NOT reflect real session sizes — a wild session was observed with 1051
 * segments (>2x the cap), so ~half its activity tiling was silently truncated
 * and the cloud stored a partial tiling. 500 was a regular data-loss point, not
 * a rare safety valve. The new value sits comfortably above the observed
 * p95/p99 (1051 seen) with generous headroom for growth, so real sessions sync
 * their full tiling and only genuine pathological outliers are ever truncated.
 * When a session still exceeds this bound (or the byte budget) the truncation is
 * LOGGED at assembly time and the synced record carries the forward-compatible
 * `activitySegmentRowsTruncated` wire signal — see that field's doc for its
 * end-to-end status (produced + validated, persistence/read-side reserved for a
 * follow-up), so today the guaranteed effect is the log, not a consumer branch.
 */
export const MAX_SYNCED_ACTIVITY_SEGMENTS = 5000;

/**
 * ISS-4541: the maximum number of activity-segment rows the cloud STORES and
 * READS BACK for a single session.
 *
 * This is DISTINCT from {@link MAX_SYNCED_ACTIVITY_SEGMENTS}, which is the
 * PER-PAYLOAD wire cap — the most rows any ONE sync chunk may carry (the ingest
 * schema enforces `.max(MAX_SYNCED_ACTIVITY_SEGMENTS)` per payload). Since
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
 * FEA-3595: inclusive upper bound the cloud accepts for a session's
 * `dataRevision` on the sync wire.
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
 * revision hitting this ceiling should be a schema change, not a silent
 * rejection.
 */
export const MAX_SUPPORTED_DATA_REVISION = 10_000 as const;

/**
 * FEA-3779: byte budget for a session's serialized `activitySegmentRows` on the
 * sync wire, in serialized-JSON bytes. This is the SECOND, byte-aware bound that
 * complements the row-count {@link MAX_SYNCED_ACTIVITY_SEGMENTS} — the tiling is
 * truncated on whichever cap it hits FIRST.
 *
 * Why a byte cap is required, not just a row cap: `activitySegmentRows` ride in
 * the session's non-paginated base payload (the desktop chunker paginates only
 * `events`/`tokenEvents`; the base — metadata previews, agents, token usage, and
 * this tiling — is replicated whole into every chunk). If the base alone exceeds
 * the transport's per-request byte cap (`SESSION_PAYLOAD_BYTE_CAP`, 256 KiB),
 * `chunkOversizedSession` returns `[]` and the WHOLE session dead-letters. Raising
 * the row cap from 500 to 5000 without a byte bound reintroduced that failure mode
 * for a moderately-large-but-non-pathological tiling (a few thousand rows can be
 * 100s of KiB), so such a session would fail to sync entirely instead of syncing a
 * capped tiling. Bounding the tiling's serialized size below a conservative reserve
 * keeps the base under the transport cap so the session always syncs (with the
 * partial flag set when the tiling was cut).
 *
 * Sized to reserve a correct margin under `SESSION_PAYLOAD_BYTE_CAP` (256 KiB):
 * 128 KiB leaves 128 KiB for the rest of the base — the metadata preview is
 * itself bounded to ~76 KiB ({@link MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS} +
 * per-message floor), so 128 KiB still covers agents / token-usage / diff-stats /
 * markers / analytics with headroom. This GUARANTEES the base stays under the
 * transport cap and the session always syncs (partial when cut), which is the
 * property that matters: a byte-capped partial tiling beats dead-lettering the
 * whole session (events, agents, metadata and all).
 *
 * Note the honest trade this constant encodes: a real activity row serializes to
 * ~150–190 bytes, so 128 KiB admits ~700–870 rows. The observed ~1051-segment
 * session serializes to ~152–194 KiB — larger than any budget that can also keep
 * the base under 256 KiB alongside a preview-heavy metadata blob — so such a
 * session is synced as a byte-capped PARTIAL tiling (flagged
 * `activitySegmentRowsTruncated`), not whole. That is intended: you cannot fit a
 * ~194 KiB tiling AND a ~76 KiB preview AND the rest of the base inside one 256 KiB
 * request, and the previous row-only cap would have dead-lettered exactly those
 * sessions. Bumping this bound trades base headroom for tiling completeness; do not
 * raise it past `SESSION_PAYLOAD_BYTE_CAP − worst-case-base` or a preview-heavy
 * session can again overflow the base and dead-letter.
 *
 * Like the row cap this is a single SSOT constant (NOT an env knob) so the desktop
 * assembly and any cloud-side accounting agree on one value.
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

export type SessionSpan = {
  first: string;
  last: string;
};

export type SessionMarker = {
  kind: "commit" | "pr" | "fail" | "frust" | "prompt";
  x: number;
  t: string;
  label: string;
  tl: number;
  illustrative?: boolean;
};

export type SessionThrottle = {
  x0: number;
  t0: string;
  t1: string;
  durMin: number;
  tl: number;
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

export type SessionPhase = {
  key: string;
  label: string;
  dur: string;
  cost: string;
  cOut: number;
  cCache: number;
  cIn: number;
};

export type PhaseIterations = Record<string, number>;

export type PhaseLoopback = {
  from: string;
  to: string;
  label: string;
  depth: number;
};

export type TurnActor = {
  name: string | null;
  sessionId: string;
  human: string | null;
  color: string;
  harness?: string | null;
};

export type SubagentBodyLine = {
  kind: "task" | "tool" | "event" | "status";
  text: string;
  t?: string;
  err?: boolean;
};

export type TurnItem =
  | {
      type: "sessionstart";
      t: string;
      actor: TurnActor & {
        machine?: string;
        isNew?: boolean;
        isResumed?: boolean;
        ci?: boolean;
      };
    }
  | {
      type: "prompt";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      costDelta?: number;
      actor: TurnActor;
      text: string;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | {
      type: "say";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      costDelta?: number;
      actor: TurnActor;
      text: string;
      /** Model that produced this turn, rendered as a muted bubble caption. */
      model?: string | null;
      /** True when this turn is a reasoning/thinking block, not a response. */
      isThinking?: boolean;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | {
      type: "tools";
      _row: number;
      t: string;
      tMs: number;
      endMs: number;
      cum: number;
      costDelta?: number;
      actor: TurnActor;
      summary: string;
      items: ToolItem[];
      hasFail: boolean;
      failN: number;
      defaultOpen?: boolean;
      cats: ToolCats;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | {
      type: "subagent";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      costDelta?: number;
      actor: TurnActor;
      sub: string;
      subagentType: string | null;
      status: string;
      model: string | null;
      duration: string | null;
      tokens: string | null;
      cost: string | null;
      body: SubagentBodyLine[];
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | {
      type: "event";
      _row: number;
      t: string;
      tMs: number;
      dot: "g" | "b" | "r";
      text: string;
      tag?: string;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | { type: "idle"; gap: number }
  | { type: "end"; text: string };

/**
 * @deprecated Compatibility type for stale clients that may still import the
 * removed Session Trace state-action endpoint response.
 */
export type AgentSessionStateUpdateResponse = {
  state: AgentSessionState;
};

export type AgentSessionListItem = {
  id: string;
  // SES-* slug of the backing Session artifact (FEA-1699). Null only until a
  // slug is allocated (every synced/backfilled session has one).
  slug: string | null;
  externalSessionId: string;
  name: string | null;
  status: string;
  origin?: AgentSessionOrigin;
  state?: AgentSessionState;
  harness: string;
  cwd: string | null;
  repositoryFullName: string | null;
  repo?: string | null;
  worktreePath: string | null;
  model: string | null;
  primaryModel?: string | null;
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
   * The numerator is NOT the bare local working-tree diff. It is
   * `max(localWorkingTreeDiff, authoredPrLinesChanged)` where
   * `localWorkingTreeDiff = linesAdded + linesRemoved` and `authoredPrLinesChanged`
   * is the summed lines changed across the session's AUTHORED PRs (see that
   * field). The local diff collapses to a tiny residual once a multi-PR session's
   * branches are merged/reset, so the roll-up is preferred when larger — that is
   * the real delivered code. `kloc = numerator / 1000`;
   * `locPerDollar = numerator / estimatedCost` — ISS-4667: raw LINES per dollar,
   * NO divide-by-1000 and never inverted, so the ratio reconciles directly with
   * the same panel's "Lines changed" and "Cost". Consumers MUST NOT reimplement
   * the old `(linesAdded + linesRemoved)`-only formula.
   *
   * Each is `null` when genuinely undefined rather than a fabricated `0`/`NaN`
   * (the UI then renders the not-applicable placeholder): `kloc` when the
   * numerator is 0, `locPerDollar` when the numerator is 0, there is no cost to
   * divide by (`estimatedCost <= 0`), or either input is non-finite. Optional +
   * additive: a version-skewed producer that omits them degrades to the client's
   * local derivation.
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
   * FEA-4378: total lines *changed* (`additions + deletions`) summed across the
   * PRs the session AUTHORED, deduped by PR identity, from platform-verified PR
   * detail — the branch's current pointer AND its historical PR set, so a PR
   * superseded on a reused branch still counts. Each PR is included only with BOTH
   * a verified `additions` and `deletions`; a partial/unfetched row is unavailable
   * and contributes nothing (never coerced to an understated total). The real
   * delivered-code signal for a multi-PR session, distinct from the session-level
   * `linesAdded/linesRemoved` scalars — which are the LOCAL working-tree git diff
   * and collapse to a tiny residual once a session's branches are merged/reset.
   * The server-projected `kloc` / `locPerDollar` use
   * `max(localWorkingTreeDiff, authoredPrLinesChanged)` as the numerator; the
   * detail view surfaces this figure in its own "Lines changed" row.
   *
   * `0` does NOT mean "no PRs" — it is returned both when the session authored no
   * PR with a complete verified LOC detail AND, deliberately, when the session's
   * PRs are SUPPRESSED because no head branch resolves (the same gate that empties
   * the rendered `prs`). Consumers must treat `0` as "no verified authored-PR LOC
   * to credit", not as a claim about PR count. Optional + additive: a
   * version-skewed producer that omits it degrades to the client's local
   * `linesAdded + linesRemoved` derivation.
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
   * FEA (PRD-536 E6): per-row local-vs-cloud sync disclosure. `pending` = this
   * session is still in the local sync outbox (un-acked by the server), so its
   * cloud copy may be missing or behind; `synced` = the cloud is caught up for
   * this row (no un-acked outbox entry, or the row was read from the cloud
   * store). Distinct from the RESPONSE-level `readSource`, which stamps the whole
   * list with which store produced it and cannot distinguish two local rows.
   * Additive + optional: a producer that doesn't compute it omits the key, and
   * consumers treat a missing/`undefined` value as "unknown — render no per-row
   * disclosure" rather than assuming `pending`.
   */
  cloudSyncState?: AgentSessionCloudSyncState;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  billingMode?: string | null;
  agentCount: number;
  toolUseCount: number;
  errorCount: number;
  baseBranch: string | null;
  sourceArtifactId: string | null;
  sourceArtifact?: AgentSessionSourceArtifactSummary | null;
  sourceLoopId: string | null;
  // Nullable since FEA-1699: a Session artifact survives its owner's deletion as
  // an org-owned record (session_detail.user_id is SetNull on user deletion).
  user: BasicUser | null;
  computeTarget: AgentSessionComputeTargetSummary;
  project: AgentSessionProjectSummary | null;
};

export type AgentSessionListResponse = {
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
};

export type AgentSessionDetail = AgentSessionListItem & {
  metadata: JsonObject | null;
  sourceArtifactId: string | null;
  sourceLoopId: string | null;
  tokenUsageByModel: SyncedAgentSessionTokenUsage[];
  attribution: SyncedAgentSessionAttribution | null;
  agents: SyncedAgentSessionAgent[];
  events: SyncedAgentSessionEvent[];
  /**
   * ISS-5075: `true` when `events` is an intentionally partial, chronological
   * PREFIX — the stored stream exceeded the detail read's row ceiling
   * (`SESSION_DETAIL_EVENT_MAX_ROWS`). `timeline`/`turnItems` derive from that
   * same prefix, so this one flag describes all three; a consumer must not
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
   * `phases`/`phaseIterations`/`phaseLoopbacks`, `throttles`, `markers`,
   * `steeringEpisodes`, and the `tracePhaseSources`/`throttleSources`/
   * `correctionSources` arrays all describe the prefix when it is set.
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
  timeline?: SessionTimelineEvent[];
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
   * FEA-3779 / FEA-4238: mirrors the sync-side `activitySegmentRowsTruncated`
   * signal onto the read shape — `true` when `activitySegmentRows` is an
   * intentionally partial, start-ordered prefix (cut on the row cap or the
   * serialized-byte budget) rather than the whole tiling. Optional + additive:
   * omitted/null means complete (the safe default), so a session synced before
   * the read projection populates this degrades to "complete" rather than
   * fabricating truncation. The Activity phases strip consumes it to avoid
   * folding or labeling a truncated prefix as "mostly idle" — an early-idle
   * prefix could have had its real work dropped from the missing tail.
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
};

export type AgentSessionUsageSummary = AgentSessionCostSplitFields & {
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
   * lying about having merged zero PRs (FEA-3574 review, wongk). A real, finite
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
  mergedKlocPerDollar?: number | null;
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
  byModel: AgentSessionUsageByModel[];
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
   * ISS-4483 (review cid 3679616168, wongk): set alongside `usageError` ONLY when
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
