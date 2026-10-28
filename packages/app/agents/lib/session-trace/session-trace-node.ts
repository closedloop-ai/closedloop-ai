/**
 * @file session-trace-node.ts
 * @description The span vocabulary the session Trace tab renders (ISS-10737).
 *
 * PRODUCER FOR EVERY FIELD. {@link SessionTraceInvocation} is a presentational
 * projection of `AgentComponentInvocationReadRow`, and the kind, attribution and
 * usage-measurement vocabularies are the CANONICAL contract constants rather
 * than mirrors of them — a re-declared copy is the drift this file exists to
 * avoid.
 *
 * THE TELEMETRY HALF IS OPTIONAL PER ROW. `durationMs` (ISS-10713),
 * `succeeded`, the token vector, `estimatedCost`, `footprintTokens` and
 * `usageMeasurement` are optional fields of the read row: a row carries each
 * one only when its producer recorded it. They stay optional here so the
 * projection below passes them through unchanged — and
 * `session-trace-disclosure.ts` is what NAMES each one that is missing, on the
 * surface, instead of rendering a zero or a bare dash for it.
 *
 * WHY EXTENT PROVENANCE IS A FIRST-CLASS FIELD. The repo already refuses to let
 * a measured count and a derived one share a column — that is
 * `AgentComponentInvocationUsageMeasurement`. A trace chart's x-axis is the same
 * hazard one dimension over: a bar whose width was measured and a bar whose
 * width was inferred from where its sibling started look identical, and reading
 * the second as latency is how a trace view lies. Every span carries its own
 * answer instead (DOC-37 section 2).
 */

import type {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationReadRow,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";

/**
 * How this span's position on the time axis was arrived at.
 *
 * `measured` — a real elapsed span bracketed this invocation. The bar's width is
 * latency.
 *
 * `inferred` — only a start instant was known, so the bar runs to whichever came
 * first: the next sibling's start, or the parent's close. The bar's width is an
 * UPPER BOUND on latency, not latency.
 *
 * `unresolved` — the invocation carries no readable `invokedAt`, so it cannot be
 * placed on the axis. It is NOT dropped: it renders in the unplaced strip with
 * its ordinal, because a node that happened is evidence even when its instant is
 * not recoverable.
 */
export const SessionTraceExtentSource = {
  Measured: "measured",
  Inferred: "inferred",
  Unresolved: "unresolved",
} as const;
export type SessionTraceExtentSource =
  (typeof SessionTraceExtentSource)[keyof typeof SessionTraceExtentSource];

/**
 * The per-invocation telemetry the Trace tab reads when it is there.
 *
 * Structurally optional rather than asserted, matching the read row. Nothing
 * here may be defaulted to zero: an absent value means "not measured", which is
 * a different statement from a measured zero (DOC-37 section 7).
 */
export type SessionTraceTelemetry = {
  /** ISS-10713. Elapsed span from the call to its matched result. */
  durationMs?: number;
  /** ISS-10718. Desktop-only column (FEA-4093) with no cloud twin yet. */
  succeeded?: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
  footprintTokens?: number;
  usageMeasurement?: AgentComponentInvocationUsageMeasurement;
};

/** One invocation row, exactly as a read surface receives it. */
export type SessionTraceInvocation = {
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
} & SessionTraceTelemetry;

/** One placed span in the derived tree. */
export type SessionTraceSpan = {
  invocation: SessionTraceInvocation;
  depth: number;
  /** Component keys of every ancestor, outermost first. */
  ancestry: readonly string[];
  /** Milliseconds from the trace origin. */
  startMs: number;
  endMs: number;
  extentSource: SessionTraceExtentSource;
  /** Extent not covered by any child — the node's own occupied time. */
  selfMs: number;
  /** Union of this node's extent with its descendants'. */
  subtreeMs: number;
  /** Turn spend billed by this node and everything under it. */
  subtreeCostUsd: number;
  /**
   * Context footprint under this node. A DIFFERENT population from turn tokens
   * and never summed with them: a component's injected text is already inside
   * the consuming turn's input count, so adding the two double-counts it
   * (DOC-37 section 4).
   */
  subtreeFootprintTokens: number;
  subtreeInputTokens: number;
  subtreeOutputTokens: number;
  /** Failures at this node and below, so a collapsed parent still shows them. */
  subtreeErrorCount: number;
  /** True when this node is on the chain that determined the finish. */
  onCriticalPath: boolean;
  children: readonly SessionTraceSpan[];
};

/** A derived tree plus everything the derivation could not place. */
export type SessionTrace = {
  roots: readonly SessionTraceSpan[];
  /** Invocations with no readable `invokedAt`, in sequence order. Never discarded. */
  unplaced: readonly SessionTraceInvocation[];
  originMs: number;
  totalMs: number;
  maxDepth: number;
  spanCount: number;
  agentCount: number;
  measuredSpanCount: number;
  inferredSpanCount: number;
  /** Placed spans whose invocation reported a failure. */
  errorCount: number;
  /**
   * Session totals, kept in their separate populations. Turn tokens and context
   * footprint are NEVER added together (DOC-37 section 4).
   */
  totalFootprintTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  /**
   * How many rows carry each telemetry population at all. A zero here means
   * "no source", which the disclosure turns into a named missing operand rather
   * than a rendered zero.
   */
  succeededReportedCount: number;
  durationReportedCount: number;
  costReportedCount: number;
  footprintReportedCount: number;
  turnTokenReportedCount: number;
};

export const SESSION_TRACE_KIND_ORDER: readonly AgentComponentInvocationKind[] =
  [
    AgentComponentInvocationKind.Command,
    AgentComponentInvocationKind.Skill,
    AgentComponentInvocationKind.Subagent,
    AgentComponentInvocationKind.Orchestration,
    AgentComponentInvocationKind.Tool,
    AgentComponentInvocationKind.Mcp,
    AgentComponentInvocationKind.Hook,
  ];

/**
 * Kind colour: a mid-tone fill per kind, verified as a 14px bar in both themes.
 *
 * Carried over verbatim from the prototype's own copy, which ISS-11819 deleted
 * — this is now the only definition, and the sandbox renders it. Including the
 * colour-vision analysis behind the set: seven hues spread around the wheel, the
 * three kinds that BILL A TURN (command, skill, subagent) holding the cool
 * violet-to-blue cluster, the gate that can block keeping `warning`, and red
 * reserved because failure owns the fill.
 *
 * HUE IS THE ONLY VISUAL CHANNEL IN THE ROWS, by an explicit operator decision
 * (DOC-37 section 5): spelling `ORCHESTRATION` beside every bar ate the name
 * gutter. The WORD lives in three other places instead — the toolbar filter chip
 * that teaches the mapping, the inspector's badge for the selected span, and
 * every row's own accessible name. The relaxation does NOT extend to failure
 * state, which always states the word.
 */
export const SESSION_TRACE_KIND_TOKEN: Readonly<
  Record<AgentComponentInvocationKind, string>
> = {
  [AgentComponentInvocationKind.Command]: "var(--chart-8)",
  [AgentComponentInvocationKind.Skill]: "var(--chart-2)",
  [AgentComponentInvocationKind.Subagent]: "var(--info)",
  [AgentComponentInvocationKind.Orchestration]: "var(--chart-9)",
  [AgentComponentInvocationKind.Tool]: "var(--chart-3)",
  [AgentComponentInvocationKind.Mcp]: "var(--chart-5)",
  [AgentComponentInvocationKind.Hook]: "var(--warning)",
};

export const SESSION_TRACE_KIND_LABEL: Readonly<
  Record<AgentComponentInvocationKind, string>
> = {
  [AgentComponentInvocationKind.Tool]: "Tool",
  [AgentComponentInvocationKind.Mcp]: "MCP",
  [AgentComponentInvocationKind.Orchestration]: "Orchestration",
  [AgentComponentInvocationKind.Command]: "Command",
  [AgentComponentInvocationKind.Skill]: "Skill",
  [AgentComponentInvocationKind.Subagent]: "Subagent",
  [AgentComponentInvocationKind.Hook]: "Hook",
};

export const SESSION_TRACE_EXTENT_LABEL: Readonly<
  Record<SessionTraceExtentSource, string>
> = {
  [SessionTraceExtentSource.Measured]: "Measured",
  [SessionTraceExtentSource.Inferred]: "Inferred",
  [SessionTraceExtentSource.Unresolved]: "Not placed",
};

/** What each extent source lets a reader conclude, in one sentence. */
export const SESSION_TRACE_EXTENT_NOTE: Readonly<
  Record<SessionTraceExtentSource, string>
> = {
  [SessionTraceExtentSource.Measured]:
    "An elapsed span bracketed this call, so the bar width is its latency.",
  [SessionTraceExtentSource.Inferred]:
    "Only a start instant was recorded. The bar runs to the next sibling or the parent's close, so its width is an upper bound on latency — not latency.",
  [SessionTraceExtentSource.Unresolved]:
    "This call carries no timestamp, so it cannot be placed on the axis. It is listed by its position in the session instead.",
};

/**
 * The kind marker, shared by the row and by the toolbar filter chip that teaches
 * it. One definition, because "the same blue" has to be the SAME blue: two call
 * sites each mixing their own tint is how a key stops matching what it keys.
 *
 * The inset ring is load-bearing, not decoration: a 10px patch of `--warning` on
 * a white row is 1.77:1 against the background, so the shape needs an edge of
 * its own to be seen at all (WCAG 1.4.11). Mixing the marker's OWN hue toward
 * the foreground darkens that edge in light and lightens it in dark, so one rule
 * covers both themes and the hue stays unchanged.
 */
export function sessionTraceKindSwatchStyle(
  kind: AgentComponentInvocationKind
) {
  const token = SESSION_TRACE_KIND_TOKEN[kind];
  return {
    backgroundColor: token,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${token} 62%, var(--foreground))`,
  };
}

/**
 * The inferred-extent fill. The ruler's key and the bars themselves both draw it
 * from here, so the swatch that explains the hatch cannot drift from the hatch
 * it explains. A FILL difference rather than a hue difference, so it survives
 * both themes and every colour-vision deficiency (WCAG 1.4.1).
 */
export function sessionTraceHatchFill(fill: string) {
  return `repeating-linear-gradient(135deg, ${fill} 0 3px, color-mix(in oklab, ${fill} 18%, transparent) 3px 6px)`;
}

/**
 * Project one read row onto the span vocabulary.
 *
 * The telemetry half is spread THROUGH rather than defaulted, so a field the
 * read row does not carry stays `undefined` and reaches the disclosure as a
 * missing operand. Defaulting any of them to `0` here would publish a measured
 * zero the producer never stated.
 */
export function toSessionTraceInvocation(
  row: AgentComponentInvocationReadRow & Partial<SessionTraceTelemetry>
): SessionTraceInvocation {
  return {
    externalInvocationId: row.externalInvocationId,
    ...(row.parentExternalInvocationId === undefined
      ? {}
      : { parentExternalInvocationId: row.parentExternalInvocationId }),
    ...(row.externalAgentId === undefined
      ? {}
      : { externalAgentId: row.externalAgentId }),
    kind: row.kind,
    componentKey: row.componentKey,
    sequence: row.sequence,
    invokedAt: row.invokedAt,
    attributionStatus: row.status,
    evidenceClass: row.evidenceClass,
    ...(row.definitionHash === undefined
      ? {}
      : { definitionHash: row.definitionHash }),
    ...(row.definitionVersionId === undefined
      ? {}
      : { definitionVersionId: row.definitionVersionId }),
    ...(row.packId === undefined ? {} : { packId: row.packId }),
    ...(row.repositoryFullName === undefined
      ? {}
      : { repositoryFullName: row.repositoryFullName }),
    ...(row.repositoryCommit === undefined
      ? {}
      : { repositoryCommit: row.repositoryCommit }),
    ...(row.branchName === undefined ? {} : { branchName: row.branchName }),
    ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
    ...(row.succeeded === undefined ? {} : { succeeded: row.succeeded }),
    ...(row.model === undefined ? {} : { model: row.model }),
    ...(row.inputTokens === undefined ? {} : { inputTokens: row.inputTokens }),
    ...(row.outputTokens === undefined
      ? {}
      : { outputTokens: row.outputTokens }),
    ...(row.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: row.cacheReadTokens }),
    ...(row.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: row.cacheWriteTokens }),
    ...(row.estimatedCost === undefined
      ? {}
      : { estimatedCost: row.estimatedCost }),
    ...(row.footprintTokens === undefined
      ? {}
      : { footprintTokens: row.footprintTokens }),
    ...(row.usageMeasurement === undefined
      ? {}
      : { usageMeasurement: row.usageMeasurement }),
  };
}
