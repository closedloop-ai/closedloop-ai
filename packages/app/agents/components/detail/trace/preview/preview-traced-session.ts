/**
 * @file preview-traced-session.ts
 * @description The SPAN-level half of the traced-session fixture, and the list
 * of API changes this sandbox presumes.
 *
 * WHY THIS LIVES IN THE SESSIONS SLICE (ISS-11819). The rows are owned by
 * `@repo/app/shared/components/generic-artifact-surface/preview/fixtures/session/`
 * and everything reducible from a row alone is reduced there. Everything here
 * needs `buildSessionTrace` — the placed tree, the activity tiling that takes
 * each band from the extent of the span that actually did that work, and the
 * session context built on top of it. `app-shared-never-imports-slices`
 * (`scripts/lint/layer-manifest.ts`) forbids the fixtures directory from loading
 * this slice, so the derivation and its dependants sit on this side of the line
 * and the rows stay on the other.
 *
 * ONE DERIVATION, NOT TWO. This calls the SAME `buildSessionTrace` the
 * production Trace tab calls. The sandbox previously carried its own copy
 * (`build-flame-trace.ts`), which ISS-11819 deleted.
 */

import {
  type AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { tracedSessionTotals } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures/session/traced-session";
import { TRACED_SESSION } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures/session/traced-session-identity";
import {
  TracedSessionActivityPhase,
  type TracedSessionActivitySegment,
  type TracedSessionContext,
  type TracedSessionInvocation,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures/session/traced-session-model";
import { tracedSessionInvocations } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures/session/traced-session-rows";
import {
  buildSessionTrace,
  flattenSpans,
} from "../../../../lib/session-trace/build-session-trace";
import type { SessionTraceSpan } from "../../../../lib/session-trace/session-trace-node";

/**
 * The API changes this sandbox presumes, recorded per `apps/prototypes/AGENTS.md`.
 * Nothing here is shipped; it is the list a production build has to close.
 */
export const PREVIEW_TRACE_PRESUMED_DERIVATION = [
  "ISS-10713 — invocation rows join to a measured extent and carry `extentSource`. Tool spans fold events.created_at with events.data.$.resultTimestamp (desktop) or the archived transcript's tool_use/tool_result pair (web, via GET /agent-sessions/[id]/transcript); a subagent takes the span of the Agent call that spawned it. No invocation column holds an elapsed span today, so every `Measured` bar here is a presumption until that lands.",
  "ISS-10714 — subagent depth is rebuilt from metadata.spawnedByToolUseId -> the spawning Agent tool call -> that call's owning subagentId. Captured at parse time, unread today: NormalizedSubagent.parentId is null across every golden dossier, so the persisted tree is depth-1 and this sandbox's nesting is a presumption until that lands.",
  "Per-kind detail (command, file, pattern, exit code) comes from the desktop events.data blob. The cloud drops summary and data (FEA-2718), so the web surface reads it from the archived transcript instead. Not separately ticketed: it rides ISS-10713's web path.",
  "ISS-10718 — per-invocation `model`, token vector, `estimatedCost`, `footprintTokens` and `usageMeasurement` are real cloud columns and ride the sync item, but are ABSENT from `AgentComponentInvocationReadRow`. The read contract stops at `branchName`. Every number in the inspector and every subtree roll-up needs them exposed there first — and so does the reconciliation this fixture depends on, since the Sessions row's cost and token cells are reduced from exactly these fields.",
  "ISS-10718 — `succeeded` is a desktop-only column (FEA-4093) with no cloud twin and no read field, so the failure treatment, the error list and `subtreeErrorCount` have no source on the web surface at all.",
  "ISS-10724 (ingest) and ISS-10725 (columns) — `findingsEmitted` and `findingsInvalidated`. NOTHING CAPTURES FINDINGS TODAY: no collector parses them out of a reviewing component's output and no column holds them, so both counts in `preview-trace-findings.ts` are authored. ISS-10724 owns the ingest that produces them and ISS-10725 owns exposing them on the invocation row; until both land, the side table keyed by `externalInvocationId` is the seam, and the confirmed count and confirmation rate stay derived from the two stored numbers rather than becoming a third.",
] as const;

/**
 * The rows, typed as the canonical projection accepts them.
 *
 * THE `buildSessionTrace` CALLS BELOW ARE THE DRIFT GUARD, NOT THIS
 * ANNOTATION — it is `TracedSessionInvocation[]` assigned to
 * `TracedSessionInvocation[]` and checks nothing. Those calls take
 * `readonly SessionTraceInvocation[]`, so a field the canonical type REQUIRES
 * going missing from the fixture, or a shared key taking an incompatible type,
 * fails `tsc` there. An extra field is not caught (a variable argument gets no
 * excess-property check) and neither is dropping an optional one. The
 * restatement in the fixtures directory exists only because the layer boundary
 * forbids importing the canonical type there.
 */
export const previewTraceInvocations: readonly TracedSessionInvocation[] =
  tracedSessionInvocations;

/**
 * The Codex/OpenCode shape: real tool calls with no `resultTimestamp`, so every
 * tool span is a point event and the whole chart is `Inferred`. This is a third
 * of the golden corpus and is the state the degraded copy must survive.
 */
export const previewTraceCodexToolPointEvents: readonly TracedSessionInvocation[] =
  previewTraceInvocations
    .filter((row) => row.invokedAt !== null)
    .slice(0, 12)
    .map((row) => ({ ...row, durationMs: undefined }));

/**
 * The placed span tree, built by the SAME function the production Trace tab
 * calls.
 *
 * Derived here rather than only inside the panel because the session's activity
 * segments and the Sessions prototype's detail timeline both need span EXTENTS,
 * not just invocation instants — a subagent that billed at its start instant
 * spent those tokens across the minutes it ran, and a timeline that draws the
 * spend as a spike at the start describes a session that did not happen.
 */
export const previewTracedSessionTrace = buildSessionTrace(
  previewTraceInvocations
);

const placedSpans = flattenSpans(previewTracedSessionTrace.roots);

/** The subagent span a given agent id ran inside, by its own root row. */
function spanForAgent(agentId: string): SessionTraceSpan | undefined {
  return placedSpans.find(
    (span) =>
      span.invocation.kind === AgentComponentInvocationKind.Subagent &&
      span.invocation.externalAgentId === agentId
  );
}

function spanForComponent(componentKey: string): SessionTraceSpan | undefined {
  return placedSpans.find(
    (span) => span.invocation.componentKey === componentKey
  );
}

type SegmentSeed = {
  phase: TracedSessionActivityPhase;
  span: SessionTraceSpan | undefined;
  /** A classified phase is a judgement, not an observation. */
  confidence: number;
  evidenceLayers: readonly string[];
  subagentId?: string;
  workItemRef?: string;
};

const WORK_ITEM_REF = `closedloop-ai/closedloop-ai#${TRACED_SESSION.pullRequestNumber}`;

/**
 * The tiling, DERIVED from the lanes rather than typed beside them.
 *
 * Each segment takes the extent of the span that actually did that work, so a
 * lane that moves in the row file moves its band with it. The explore band is
 * the only one with an authored boundary — it runs from the trace origin to the
 * instant the planner took over, which is what "before the first subagent" means.
 *
 * The uncovered stretches are the session's two idle gaps. `segmentCoverage` is
 * computed from them, so the shortfall the header states is a real one rather
 * than a decorative number just under 100%.
 */
const SEGMENT_SEEDS: readonly SegmentSeed[] = [
  {
    phase: TracedSessionActivityPhase.Explore,
    span: spanForAgent("ag-1"),
    confidence: 0.82,
    evidenceLayers: ["tool", "prose"],
  },
  {
    phase: TracedSessionActivityPhase.Plan,
    span: spanForAgent("ag-1"),
    confidence: 0.9,
    evidenceLayers: ["tool", "subagent"],
    subagentId: "ag-1",
  },
  {
    phase: TracedSessionActivityPhase.Implement,
    span: spanForAgent("ag-2"),
    confidence: 0.93,
    evidenceLayers: ["tool", "subagent"],
    subagentId: "ag-2",
    workItemRef: WORK_ITEM_REF,
  },
  {
    phase: TracedSessionActivityPhase.Validate,
    span: spanForAgent("ag-7"),
    confidence: 0.88,
    evidenceLayers: ["tool", "subagent"],
    subagentId: "ag-7",
  },
  {
    phase: TracedSessionActivityPhase.Review,
    span: spanForComponent("visual-qa"),
    confidence: 0.91,
    evidenceLayers: ["tool", "prose"],
    workItemRef: WORK_ITEM_REF,
  },
];

function buildSegments(): TracedSessionActivitySegment[] {
  const segments: TracedSessionActivitySegment[] = [];
  for (const seed of SEGMENT_SEEDS) {
    if (seed.span === undefined) {
      continue;
    }
    // Explore is the run-up to the first subagent, not the subagent itself.
    const isExplore = seed.phase === TracedSessionActivityPhase.Explore;
    const startMs = isExplore ? 0 : seed.span.startMs;
    const endMs = isExplore ? seed.span.startMs : seed.span.endMs;
    segments.push({
      phase: seed.phase,
      startMs,
      endMs,
      confidence: seed.confidence,
      evidenceLayers: seed.evidenceLayers,
      subagentId: seed.subagentId,
      workItemRef: seed.workItemRef,
    });
  }
  return segments;
}

const previewTracedSessionSegments = buildSegments();

const segmentCoverage =
  previewTracedSessionTrace.totalMs === 0
    ? 0
    : previewTracedSessionSegments.reduce(
        (sum, segment) => sum + (segment.endMs - segment.startMs),
        0
      ) / previewTracedSessionTrace.totalMs;

/**
 * How confidently each dollar was attributed. Split rather than blended: one
 * total would hide that a slice of it is a guess. The shares are stated and the
 * high-confidence remainder is derived, so the three can only ever sum to the
 * session total.
 */
const LOW_CONFIDENCE_SPEND_SHARE = 0.06;
const MEDIUM_CONFIDENCE_SPEND_SHARE = 0.24;

const spendLowConfidenceUsd =
  tracedSessionTotals.costUsd * LOW_CONFIDENCE_SPEND_SHARE;
const spendMediumConfidenceUsd =
  tracedSessionTotals.costUsd * MEDIUM_CONFIDENCE_SPEND_SHARE;

/**
 * The session-grain signals that sit around the tree.
 *
 * Every field here maps to a column or table we ALREADY persist and the Trace
 * tab has simply never read — activity segments with their confidence and
 * work-item ref, the autonomy band, the spend split by attribution confidence,
 * and the transcript's sync state. That is a different kind of gap from
 * ISS-10713 and ISS-10714, which are data we do not hold at all, and the two
 * should not be confused when deciding what to build next.
 */
export const previewTracedSessionContext: TracedSessionContext = {
  autonomyBand: "agentic",
  spendHighConfidenceUsd:
    tracedSessionTotals.costUsd -
    spendMediumConfidenceUsd -
    spendLowConfidenceUsd,
  spendMediumConfidenceUsd,
  spendLowConfidenceUsd,
  segmentCoverage,
  segments: previewTracedSessionSegments,
  transcriptSyncStatus: "synced",
  transcriptSyncedByteOffset: 4_218_940,
  transcriptSyncClass: "incremental",
  pullRequestUrl: TRACED_SESSION.pullRequestUrl,
  pullRequestNumber: TRACED_SESSION.pullRequestNumber,
  // Only what the session's own root-level `Edit` actually wrote. Files the
  // tree merely READ are deliberately not listed here.
  filesChanged: [TRACED_SESSION.editedFile],
};

/** The activity phase covering an offset, for anything drawing a band. */
export function previewTracedSessionPhaseAt(
  offsetMs: number
): TracedSessionActivityPhase {
  const segment = previewTracedSessionSegments.find(
    (candidate) => offsetMs >= candidate.startMs && offsetMs < candidate.endMs
  );
  return segment?.phase ?? TracedSessionActivityPhase.Idle;
}

/**
 * The sandbox's two presumed per-span fields, keyed by invocation id.
 *
 * WHY A SIDE TABLE RATHER THAN A WIDER SPAN. `buildSessionTrace` returns
 * `SessionTraceSpan`, whose `invocation` is the production type, so an extra
 * field is erased from the TYPE even though the object still carries it at
 * runtime — and widening the production model to serve a sandbox is the drift
 * ISS-11819 removed. A map keyed by `externalInvocationId` is also exactly the
 * seam `PREVIEW_TRACE_PRESUMED_DERIVATION` already records for the
 * ISS-10724/ISS-10725 findings counts, so there is one answer to "where do
 * unlanded fields live" rather than two.
 *
 * A LOOKUP THAT MISSES IS ABSENT, NEVER ZERO. These fields have no producer at
 * all, so an invented `0` or `""` would be this sandbox publishing a measurement
 * nobody made.
 */
export type PreviewSpanExtras = {
  parentAgentId?: string;
  detail?: Readonly<Record<string, string>>;
};

export function indexSpanExtras(
  invocations: readonly TracedSessionInvocation[]
): ReadonlyMap<string, PreviewSpanExtras> {
  const byId = new Map<string, PreviewSpanExtras>();
  for (const invocation of invocations) {
    if (
      invocation.parentAgentId === undefined &&
      invocation.detail === undefined
    ) {
      continue;
    }
    byId.set(invocation.externalInvocationId, {
      ...(invocation.parentAgentId === undefined
        ? {}
        : { parentAgentId: invocation.parentAgentId }),
      ...(invocation.detail === undefined ? {} : { detail: invocation.detail }),
    });
  }
  return byId;
}

/**
 * The evidence-class label, for the sandbox inspector's "Attributed from" row.
 *
 * An exhaustive `Record` over the canonical enum, so a new member added to
 * `AgentComponentInvocationEvidenceClass` fails `tsc` here rather than rendering
 * a raw camelCase key. A production twin exists at
 * `agents/components/workspace/invocation-evidence-list.tsx` (`EVIDENCE_LABELS`,
 * module-local); unifying the two is not ISS-11819's scope.
 */
export const PREVIEW_EVIDENCE_LABEL: Readonly<
  Record<AgentComponentInvocationEvidenceClass, string>
> = {
  transcriptSnapshot: "Transcript",
  collectorSnapshot: "Collector",
  otelCounter: "OTel counter",
  repositoryCommit: "Repository commit",
  packMembership: "Pack membership",
  none: "None",
};
