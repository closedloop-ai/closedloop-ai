/**
 * @file traced-session.ts
 * @description The ONE session both the Sessions prototype and the Session
 * Trace Tab prototype describe, and the headline figures REDUCED from its rows.
 *
 * WHY THIS FILE EXISTS. The Sessions table and the trace used to be two
 * unrelated fixtures, so a demo that walked from the table into the Trace tab
 * changed session halfway and read as a mockup. One session now owns both: the
 * Web Master Sessions row
 * (`packages/app/agents/components/sessions/web-master-legacy-preview/mock.ts`), the
 * package-owned `SES-7B91` artifact (`../../fixtures.ts`), the prototype-owned
 * detail timeline
 * (`packages/app/agents/components/sessions/web-master-legacy-preview/mock-detail.ts`) and the
 * sessions-slice trace adapter
 * (`packages/app/agents/components/detail/trace/preview/preview-traced-session.ts`)
 * all read `./traced-session-rows.ts`. Every headline figure is reduced from
 * those rows rather than restated.
 *
 * WHAT IS REDUCED HERE AND WHAT IS NOT (ISS-11819). Everything below is
 * ROW-LEVEL: it needs an invocation's own `invokedAt`, `durationMs` and token
 * vector and nothing else. The SPAN-LEVEL half — the placed tree, the activity
 * tiling that takes each band from the extent of the span that did the work, and
 * the session context built on it — needs `buildSessionTrace`, which lives in
 * the sessions feature slice. `app-shared-never-imports-slices`
 * (`scripts/lint/layer-manifest.ts`) forbids this directory from loading it, so
 * that half lives beside the derivation in `preview-traced-session.ts` and this
 * file stays reducible from the rows alone.
 *
 * `wallClockMs` is on this side of that line deliberately: it is the first
 * `invokedAt` to the last `invokedAt + durationMs`, which is row arithmetic. It
 * agrees with the trace's own `totalMs` because both read the same two
 * instants — not because one is derived from the other.
 *
 * WHERE THE SHAPE COMES FROM. Scaffolded from a real local capture and then
 * scrubbed to the bone. The source is session
 * `491c3831-c6f6-4f83-a4b6-b60eea6eed0c` in the desktop store's
 * `agent_component_invocations` — a `/design-review` run of this same pack, 516
 * rows, 14 agents, 13 `Agent` spawns, read read-only on 2026-09-19.
 *
 * KEPT FROM IT: the lane skeleton (one command, one skill under it, `Agent` ->
 * subagent pairs fanning out of that skill, shallow leaves back at the root),
 * the kind vocabulary and its ordering, and the fact that a real session is
 * mostly tool calls punctuated by hooks — the capture runs 83% tool / 9% hook /
 * 5% orchestration / 2.5% subagent, and this fixture runs 60% / 7% / 13% / 7%,
 * denser in the non-tool kinds because a 159-row fixture has to show each kind
 * at all. Kept too: real idle gaps between lanes, real subagent role names, and
 * the fact that the deepest work sits under a critic rather than under the
 * planner.
 *
 * SCRUBBED FROM IT: everything with content in it. No transcript text, tool
 * input or output, bash command body, absolute or home-relative path, private
 * repo name, real branch, real PR, commit SHA, prompt or hook body survives.
 * The capture's own session id, agent ids and `provider_tool_use_id`s are gone;
 * ids here are the emission ordinal. The `detail` maps are hand-written
 * one-liners, not captured payloads.
 *
 * SYNTHESISED, AND WHY THE CAPTURE COULD NOT SUPPLY IT. Four things this
 * prototype exists to render are ABSENT from the corpus, not merely absent from
 * that one session, so they are composed rather than sampled and no future read
 * will find them:
 *  - FAILURES. `succeeded` is NULL on 455,404 of the corpus's 457,224 rows and
 *    on 468 of this capture's 516; the capture has zero failures. The five here
 *    are placed by hand at the depths and kinds a debugger has to reach.
 *  - DEPTH. Every subagent in the capture has `parent_agent_id` = the main
 *    agent, so the persisted tree is depth-1 (see below). The eleven levels here
 *    are composed.
 *  - PER-ROW BILLING. One row of 516 carries an `estimated_cost`, and
 *    `footprint_tokens` is zero corpus-wide. Every token vector here is
 *    authored and every cost is priced from it.
 *  - EXTENTS. No invocation column holds an elapsed span at all, so every
 *    `durationMs` is composed. What is real is the RULE deciding which rows may
 *    carry one, documented next.
 *
 * WHERE THE EXTENTS COME FROM, AND WHY THEY ARE MIXED. This is the part a
 * prototype must not flatter.
 *
 *  - TOOL calls are `Measured`. A Claude tool call persists a start
 *    (`events.created_at`) and an end (`events.data.$.resultTimestamp`), and
 *    `toolCallDurationMs` (`packages/lib/sessions/agent-session-tool-detail.ts`)
 *    already folds the pair. Coverage on the Claude golden dossiers is
 *    effectively total — `8be9cfc9` 377/377, `c8a3eb17` 323/323, `be42c362`
 *    344/345. Codex and OpenCode dossiers carry NO `resultTimestamp`, so their
 *    tool calls are point events; `previewTraceCodexToolPointEvents` is that case.
 *  - SUBAGENT spans are `Measured` only because the spawning `Agent` tool call
 *    brackets them. That join is real and measured: golden dossier `96fef0b5`'s
 *    `Agent` call `toolu_01H9mHk68boMNEqNEs9ccMaD` runs 12:16:43.682Z ->
 *    12:18:32.189Z, a 108,507 ms span, and its `spawnedByToolUseId` names the
 *    child. The subagent row's own `startedAt`/`endedAt` are folded flat on a
 *    sidecar and cannot be used for this.
 *  - SKILL and COMMAND activations are `Inferred`. Nothing brackets them: they
 *    are a single transcript instant, so the bar runs to the next sibling.
 *  - Two rows are deliberately `Unresolved` (no `invokedAt`) to exercise the
 *    unplaced strip, which is the state a minimal harness produces.
 *
 * DEPTH IS THE HONEST WEAK POINT AND THE FIXTURE SAYS SO.
 * `parentExternalInvocationId` is populated here throughout. In real persisted
 * data it is not: `NormalizedSubagent.parentId` is null across every golden
 * dossier, so the stored agent tree is depth-1. The evidence to rebuild the
 * depth below IS captured — `metadata.spawnedByToolUseId`,
 * `metadata.parentUuid`, `providerToolUseId` — and is simply not read yet. See
 * `PREVIEW_TRACE_PRESUMED_DERIVATION` in the sessions-slice adapter.
 */

import type { TracedSessionInvocation } from "./traced-session-model";
import { tracedSessionInvocations } from "./traced-session-rows";

/**
 * The session headline, REDUCED from the rows.
 *
 * Nothing here is typed by hand, which is the whole point: the Sessions row and
 * the Trace tab's header both read these, so the table's cost and token cells
 * are the same arithmetic the trace summary runs over the same population.
 * Turn tokens and footprint tokens stay in separate fields and are never added
 * — a component's injected text is already inside the consuming turn's input
 * count.
 */
export type TracedSessionTotals = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /**
   * Over EVERY row, the unplaced ones included. The Trace tab's own footprint
   * stat is over placed spans only, so the two differ by exactly the unplaced
   * rows' footprint — they are not the same population and must not be read as
   * a disagreement.
   */
  footprintTokens: number;
  invocationCount: number;
  agentCount: number;
  errorCount: number;
  /** Trace origin to the last observed end, the span the chart's axis covers. */
  wallClockMs: number;
};

function reduceTracedSession(
  rows: readonly TracedSessionInvocation[]
): TracedSessionTotals {
  const agents = new Set<string>();
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let footprintTokens = 0;
  let errorCount = 0;
  let originMs = Number.POSITIVE_INFINITY;
  let lastEndMs = 0;

  for (const row of rows) {
    costUsd += row.estimatedCost ?? 0;
    inputTokens += row.inputTokens ?? 0;
    outputTokens += row.outputTokens ?? 0;
    cacheReadTokens += row.cacheReadTokens ?? 0;
    footprintTokens += row.footprintTokens ?? 0;
    if (row.succeeded === false) {
      errorCount += 1;
    }
    if (row.externalAgentId !== undefined) {
      agents.add(row.externalAgentId);
    }
    if (row.invokedAt === null) {
      continue;
    }
    const startedMs = Date.parse(row.invokedAt);
    originMs = Math.min(originMs, startedMs);
    lastEndMs = Math.max(lastEndMs, startedMs + (row.durationMs ?? 0));
  }

  return {
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    footprintTokens,
    invocationCount: rows.length,
    agentCount: agents.size,
    errorCount,
    wallClockMs: Number.isFinite(originMs) ? lastEndMs - originMs : 0,
  };
}

export const tracedSessionTotals: TracedSessionTotals = reduceTracedSession(
  tracedSessionInvocations
);
