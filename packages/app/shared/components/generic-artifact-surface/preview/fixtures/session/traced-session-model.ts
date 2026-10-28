/**
 * @file traced-session-model.ts
 * @description The shape of one traced-session fixture row, and the
 * session-grain vocabulary the tiling is written in.
 *
 * WHAT THIS IS NOT. It is not a span, a trace, a kind key, an extent source, a
 * colour token or an extent note. All of those are
 * `packages/app/agents/lib/session-trace/session-trace-node.ts`, the one
 * definition the production Trace tab renders, and this sandbox renders the
 * same derivation (`buildSessionTrace`) over the rows below — so the two cannot
 * disagree about what a bar means. Before ISS-11819 there were two copies of
 * that vocabulary and two copies of the derivation; the copies are gone.
 *
 * WHY THE ROW SHAPE IS RESTATED HERE RATHER THAN IMPORTED. `SessionTraceInvocation`
 * lives in the sessions feature slice, and `app-shared-never-imports-slices`
 * (`scripts/lint/layer-manifest.ts`) forbids `packages/app/shared/**` from
 * loading `packages/app/agents/**`. The fixture rows are consumed by surfaces on
 * both sides of that line, so they are declared here and the identity half is
 * pinned to the CANONICAL `@repo/api` constants rather than to mirrors of them.
 *
 * WHAT PINS THE RESTATEMENT, AND WHAT DOES NOT. `preview-traced-session.ts` in
 * the sessions slice passes these rows straight to `buildSessionTrace`, whose
 * parameter is `readonly SessionTraceInvocation[]`. Drop a field the canonical
 * type REQUIRES, or give a shared key an incompatible type, and that call fails
 * `tsc`. It does NOT catch an EXTRA field — the rows reach the call as a
 * variable, which gets no excess-property check, which is how `parentAgentId`
 * and `detail` live here while being absent from the canonical type — and it
 * does not catch dropping an OPTIONAL one. Those two cases are review's.
 */

import type {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";

/**
 * One fixture row, in the span vocabulary's own terms.
 *
 * The telemetry half is optional for the same reason the canonical projection
 * makes it optional: an absent value means "not measured", which is a different
 * statement from a measured zero. Nothing here may be defaulted to `0`.
 */
export type TracedSessionInvocation = {
  externalInvocationId: string;
  parentExternalInvocationId?: string;
  externalAgentId?: string;
  kind: AgentComponentInvocationKind;
  componentKey: string;
  sequence: number;
  invokedAt: string | null;
  attributionStatus: AgentComponentInvocationAttributionStatus;
  evidenceClass: AgentComponentInvocationEvidenceClass;
  definitionHash?: string;
  definitionVersionId?: string;
  packId?: string;
  repositoryFullName?: string;
  repositoryCommit?: string;
  branchName?: string;
  durationMs?: number;
  succeeded?: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
  footprintTokens?: number;
  usageMeasurement?: AgentComponentInvocationUsageMeasurement;
  /**
   * PRESUMED — ISS-10714. The agent whose call spawned this one.
   * `NormalizedSubagent.parentId` is null across every golden dossier, so the
   * persisted tree is depth-1 and this field has no producer today.
   */
  parentAgentId?: string;
  /**
   * PRESUMED — the desktop `events.data` blob. Per-kind detail (command, file,
   * pattern, exit code). The cloud drops it (FEA-2718); the web surface would
   * read it from the archived transcript, which rides ISS-10713's path.
   */
  detail?: Readonly<Record<string, string>>;
};

/** Mirrors the `phase` vocabulary in `collectors/parsing/activity-taxonomy.ts`. */
export const TracedSessionActivityPhase = {
  Explore: "explore",
  Plan: "plan",
  Implement: "implement",
  Review: "review",
  Validate: "validate",
  Rework: "rework",
  Other: "other",
  Idle: "idle",
} as const;
export type TracedSessionActivityPhase =
  (typeof TracedSessionActivityPhase)[keyof typeof TracedSessionActivityPhase];

/**
 * One tiled phase of the session. REAL rows (`session_activity_segments`:
 * phase, start_ms, end_ms, confidence, evidence_layers, work_item_ref,
 * subagent_id) that no surface reads yet.
 *
 * `confidence` travels with every segment because a classified phase is a
 * judgement, not an observation, and a band drawn without it would read as
 * measured.
 */
export type TracedSessionActivitySegment = {
  phase: TracedSessionActivityPhase;
  startMs: number;
  endMs: number;
  confidence: number;
  evidenceLayers: readonly string[];
  /** The ticket or PR this stretch of work was against. */
  workItemRef?: string;
  /** The agent whose work this segment describes, when it was not the main one. */
  subagentId?: string;
};

/**
 * Session-grain signals that sit around the tree rather than on a span.
 *
 * ALL OF THESE ARE REAL AND PERSISTED. They need wiring, not a schema change —
 * unlike the two things this sandbox genuinely presumes (ISS-10713, ISS-10714).
 * The distinction is worth keeping visible: the gap between what we capture and
 * what we show is much wider than the gap between what we capture and what
 * exists.
 */
export type TracedSessionContext = {
  /** `session_activity_metrics.autonomy_band`. */
  autonomyBand: string;
  /**
   * `session_activity_metrics` splits spend by how confidently it was
   * attributed. One blended total would hide that a third of it is a guess.
   */
  spendHighConfidenceUsd: number;
  spendMediumConfidenceUsd: number;
  spendLowConfidenceUsd: number;
  /** Share of the session the segment tiling actually covers, 0..1. */
  segmentCoverage: number;
  segments: readonly TracedSessionActivitySegment[];
  /** `transcript_sync_state` — whether the evidence behind a view reached the cloud. */
  transcriptSyncStatus: string;
  transcriptSyncedByteOffset: number;
  transcriptSyncClass: string;
  /** Artifact linkage at session grain. */
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  filesChanged: readonly string[];
};
