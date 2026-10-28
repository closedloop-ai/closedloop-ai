/**
 * ISS-6409: the desktop-local LOC/$ derivation for agent components — the fold,
 * the kind gate, and the raw terms the summary card sums.
 *
 * Extracted from `shared-agent-components-api.ts` (root AGENTS.md, shrink-only
 * grandfather rule): that file is over the line ceiling, and this is the
 * cohesive unit ISS-6409 touched. It also puts the desktop reader in the same
 * shape as its cloud twin, which has lived in its own
 * `apps/api/app/agent-components/loc-per-dollar.ts` since FEA-4052.
 */

import {
  type AgentComponent,
  type AgentComponentKind,
  isLocPerDollarVerifiableKind,
} from "@repo/api/src/types/agent-component";
import {
  InvocationLocPerDollarUncoveredOperand,
  resolveInvocationLocPerDollar,
} from "@repo/api/src/types/agent-component-invocation-lines";
import {
  computeLocPerDollarTerms,
  locPerDollarFromCoercedLines,
  measuredCostSessionIds,
} from "@repo/api/src/utils/loc-per-dollar";
import type { SharedAgentSessionLocCost } from "../session/session-loc-cost.js";

/**
 * FEA-4052: LOC/$ for one component GATED on its kind's per-component
 * attribution reliability ({@link isLocPerDollarVerifiableKind}) — the desktop-local
 * twin of the cloud `locPerDollarForKind` in
 * apps/api/app/agent-components/loc-per-dollar.ts. A non-verifiable kind returns
 * null so the desktop surface hides LOC/$ exactly as the web does. Only `subagent` is
 * verifiable today; skill/command are excluded until a session can be
 * partitioned across its co-invoked components (whitlockk, PR #3720).
 */
export function locPerDollarForKind(
  kind: string,
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SharedAgentSessionLocCost>
): number | null {
  if (!isLocPerDollarVerifiableKind(kind as AgentComponentKind)) {
    return null;
  }
  const terms = computeLocPerDollarTerms(sessionIds, locCostBySession);
  // ISS-4667: raw lines per dollar via the shared SSOT — NO divide-by-1000.
  // ISS-9980's measured-zero rule does NOT reach this fold: its numerator
  // coerces never-synced NULL columns to 0, so a zero stays NOT KNOWABLE here.
  return locPerDollarFromCoercedLines(terms.lines, terms.cost);
}

/**
 * ISS-6409: the population LOC/$ fold — the desktop-local twin of the cloud
 * `foldPopulationLocPerDollar`.
 *
 * Folds over the UNION of the population's sessions. Per-component terms are
 * not additive: one session can invoke several subagents and each component's
 * terms count that session's full LOC and cost, so summing them weights a
 * shared session once per component that used it — a third estimand, neither
 * the union's rate nor the one the Sessions and Branches cards compute
 * (#6417 review).
 *
 * `sampleSize` names the population the figure was folded OVER — every
 * verifiable component that put at least one COST-MEASURED session into the
 * union —
 * not the components that happen to carry their own measurable ratio.
 *
 * Counting the latter let the two fields contradict each other in both
 * directions. Systematically it understated: 500 components' sessions in the
 * union, "across 23 components" underneath. And it was reachable outright —
 * one component with LOC but no priced spend nulls on `cost <= 0`, another
 * with spend but no git LOC nulls on `lines <= 0`, so neither is counted while
 * the union carries both terms and renders a real number above "across 0
 * components". A ratio of sums has no per-component sample to count; the honest
 * disclosure is the population that fed the sums. When the fold yields nothing,
 * the count goes to zero with it rather than claiming a measured sample.
 */
export function foldPopulationLocPerDollar(
  components: readonly Pick<AgentComponent, "slug" | "kind">[],
  sessionIdsBySlug: Map<string, Iterable<string>>,
  locCostBySession: Map<string, SharedAgentSessionLocCost>
): { locPerDollar: number | null; sampleSize: number } {
  const unionSessionIds = new Set<string>();
  let sampleSize = 0;
  for (const component of components) {
    if (!isLocPerDollarVerifiableKind(component.kind)) {
      continue;
    }
    const sessionIds = sessionIdsBySlug.get(component.slug);
    if (!sessionIds) {
      continue;
    }
    const measured = measuredCostSessionIds(sessionIds, locCostBySession);
    if (measured.length === 0) {
      continue;
    }
    for (const sessionId of measured) {
      unionSessionIds.add(sessionId);
    }
    sampleSize += 1;
  }
  const union = computeLocPerDollarTerms(unionSessionIds, locCostBySession);
  const locPerDollar = locPerDollarFromCoercedLines(union.lines, union.cost);
  return {
    locPerDollar,
    sampleSize: locPerDollar === null ? 0 : sampleSize,
  };
}

/**
 * ISS-10730: the LOC/$ fields for one desktop component row — the ratio plus,
 * when it is absent, the NAMED operand that was not covered.
 *
 * One helper rather than two assignments at each of the three emit sites: a
 * reason attached beside a resolved ratio would state a shortfall that did not
 * occur, and that rule must have exactly one spelling. Web emits the identical
 * pair through `emitLocPerDollarWithLegacy`.
 */
export function emitDesktopLocPerDollar(
  kind: string,
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SharedAgentSessionLocCost>
): {
  locPerDollar: number | null;
  locPerDollarUncoveredOperand?: InvocationLocPerDollarUncoveredOperand;
} {
  const locPerDollar = locPerDollarForKind(kind, sessionIds, locCostBySession);
  const uncoveredOperand = locPerDollarUncoveredOperand(
    kind,
    sessionIds,
    locCostBySession
  );
  return {
    locPerDollar,
    ...(locPerDollar === null && uncoveredOperand !== undefined
      ? { locPerDollarUncoveredOperand: uncoveredOperand }
      : {}),
  };
}

/**
 * ISS-10730 — the operand a LOC/$ suppression could not cover, for ONE
 * component, derived from the TERMS rather than from the kind alone.
 *
 * The kind gate is only half the population. A verifiable (`subagent`) kind
 * proceeds to the division and still returns null when the summed cost is 0 or
 * the sessions produced no measurable lines — and at that point the producer
 * knows WHICH half failed. Naming it only for the kinds whose ratio was never
 * attempted left the rows a reader most needs an explanation for carrying a
 * bare null, which is the silently-absent slot the field exists to remove.
 *
 * Returns `undefined` when the ratio resolved — a reason beside a real number
 * would state a shortfall that did not occur.
 *
 * DELIBERATELY NOT THE CLOUD'S MEASURED-$0 ARM (whitlockk, #7718 review). The cloud
 * twin passes a measured `0` through so the resolver answers `zero_cost` rather
 * than naming `cost` uncovered, because there `costMeasured` is real
 * (`estimatedCost !== null`). Desktop cannot make that claim: `costMeasured` is
 * hardcoded `true` in `session-loc-cost.ts` because `sumTokenUsage` cannot tell
 * "no token rows" from "rows summing to zero" (see {@link
 * measuredCostSessionIds}, INERT here for the same reason). So a desktop zero
 * stays UNKNOWN and is reported as an uncovered `cost` — asserting "we measured
 * this work as free" on evidence desktop does not have would be the worse lie.
 * When desktop can distinguish the two, this arm should match the cloud's.
 */
export function locPerDollarUncoveredOperand(
  kind: string,
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SharedAgentSessionLocCost>
): InvocationLocPerDollarUncoveredOperand | undefined {
  if (!isLocPerDollarVerifiableKind(kind as AgentComponentKind)) {
    return InvocationLocPerDollarUncoveredOperand.Lines;
  }
  const terms = computeLocPerDollarTerms(sessionIds, locCostBySession);
  const resolved = resolveInvocationLocPerDollar({
    lines: terms.lines > 0 ? terms.lines : null,
    costUsd: terms.cost > 0 ? terms.cost : null,
  });
  return resolved.state === "suppressed"
    ? resolved.uncoveredOperand
    : undefined;
}

/**
 * ISS-10730: stamp the LOC/$ pair onto every row of a list page.
 *
 * The loop lives here rather than at the call site so all THREE desktop emit
 * sites go through {@link emitDesktopLocPerDollar} — the list column and the
 * two detail views can never describe the same component with different
 * reasons, because the rule has exactly one spelling.
 */
export function applyDesktopLocPerDollar(
  items: Pick<AgentComponent, "id" | "kind" | "locPerDollar">[],
  sessionIdsByComponentId: Map<string, Set<string>>,
  locCostBySession: Map<string, SharedAgentSessionLocCost>
): void {
  for (const item of items) {
    Object.assign(
      item,
      emitDesktopLocPerDollar(
        item.kind,
        sessionIdsByComponentId.get(item.id) ?? [],
        locCostBySession
      )
    );
  }
}
