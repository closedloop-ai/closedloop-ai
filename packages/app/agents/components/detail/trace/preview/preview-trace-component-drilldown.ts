/**
 * @file preview-trace-component-drilldown.ts
 * @description The SECOND drill-in: leave the tree sideways and ask what one
 * component does EVERYWHERE in this session.
 *
 * Not "what did this call do" but every invocation of it, what they cost, which
 * agents reached them, and whether they all ran the same definition. The view
 * keeps the span you came from so Back returns to it rather than to the top of
 * the chart.
 *
 * FOCUS IS NOT HERE. Re-rooting on a span, its ancestor trail and its window are
 * `session-trace-drilldown.ts` in the sessions slice, which production also
 * uses; the sandbox previously carried a second copy of it (ISS-11819).
 * Production deliberately ships the focus drill-in ALONE — that module's own
 * header records why — so this derivation and its panel stay on the sandbox
 * side rather than being wired into a production surface that has no entry
 * point for them.
 *
 * WHY MEASURED TIME CARRIES ITS OWN DENOMINATOR. A component that ran eleven
 * times but was bracketed only twice has a real measured total and a real
 * shortfall, and both travel together: "4.2s across 2 of 11 measured" is a
 * usable number, "4.2s" alone is a wrong one. The figure is published with its
 * coverage beside it rather than withheld for being partial.
 */

import type { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { flattenSpans } from "../../../../lib/session-trace/build-session-trace";
import {
  SessionTraceExtentSource,
  type SessionTraceSpan,
} from "../../../../lib/session-trace/session-trace-node";

/** A component's whole footprint in one session. */
export type PreviewTraceComponentDrilldown = {
  kind: AgentComponentInvocationKind;
  componentKey: string;
  occurrences: readonly SessionTraceSpan[];
  invocationCount: number;
  /** Turn spend billed by this component's own calls. Never a session total. */
  ownCostUsd: number;
  /** Context footprint, kept apart from turn spend — a different population. */
  footprintTokens: number | undefined;
  /** Extent summed over occurrences whose extent was MEASURED. */
  measuredMs: number;
  measuredOccurrenceCount: number;
  /** Distinct agents that reached this component. */
  agentIds: readonly string[];
  /** Distinct definition hashes seen. More than one means it changed mid-session. */
  definitionHashes: readonly string[];
  failureCount: number;
};

/** A component identity that survives a URL round trip. */
export function encodeComponentRef(
  kind: AgentComponentInvocationKind,
  componentKey: string
): string {
  return `${kind}:${componentKey}`;
}

export function decodeComponentRef(
  raw: string | null
): { kind: AgentComponentInvocationKind; componentKey: string } | null {
  if (raw === null) {
    return null;
  }
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    return null;
  }
  return {
    kind: raw.slice(0, separator) as AgentComponentInvocationKind,
    componentKey: raw.slice(separator + 1),
  };
}

export function buildComponentDrilldown(
  roots: readonly SessionTraceSpan[],
  kind: AgentComponentInvocationKind,
  componentKey: string
): PreviewTraceComponentDrilldown | null {
  const occurrences = flattenSpans(roots).filter(
    (span) =>
      span.invocation.kind === kind &&
      span.invocation.componentKey === componentKey
  );
  if (occurrences.length === 0) {
    return null;
  }

  const agentIds = new Set<string>();
  const definitionHashes = new Set<string>();
  let ownCostUsd = 0;
  let footprintTokens: number | undefined;
  let measuredMs = 0;
  let measuredOccurrenceCount = 0;
  let failureCount = 0;

  for (const span of occurrences) {
    const { invocation } = span;
    ownCostUsd += invocation.estimatedCost ?? 0;
    if (invocation.footprintTokens !== undefined) {
      footprintTokens = (footprintTokens ?? 0) + invocation.footprintTokens;
    }
    // Only measured extents are summed. Adding an inferred one would turn an
    // upper bound into a reported total, which is the lie this whole view exists
    // to avoid — the count beside it says how much of the set is represented.
    if (span.extentSource === SessionTraceExtentSource.Measured) {
      measuredMs += span.subtreeMs;
      measuredOccurrenceCount += 1;
    }
    if (invocation.externalAgentId !== undefined) {
      agentIds.add(invocation.externalAgentId);
    }
    if (invocation.definitionHash !== undefined) {
      definitionHashes.add(invocation.definitionHash);
    }
    if (invocation.succeeded === false) {
      failureCount += 1;
    }
  }

  return {
    kind,
    componentKey,
    occurrences,
    invocationCount: occurrences.length,
    ownCostUsd,
    footprintTokens,
    measuredMs,
    measuredOccurrenceCount,
    agentIds: [...agentIds],
    definitionHashes: [...definitionHashes],
    failureCount,
  };
}
