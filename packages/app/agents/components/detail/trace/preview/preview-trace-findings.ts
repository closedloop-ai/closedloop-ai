/**
 * @file preview-trace-findings.ts
 * @description What a reviewing component actually FOUND, per invocation.
 *
 * WHY THIS EXISTS. A `review-soul` span today carries tokens and dollars and
 * nothing about whether it found anything, so a cost-only comparison ranks the
 * laziest reviewer first. Two counts fix that: how many findings an invocation
 * emitted, and how many of those were later invalidated. The survivors are its
 * output.
 *
 * CONFIRMED AND THE RATE ARE DERIVED, NEVER STORED. `findingsConfirmed` is
 * `emitted - invalidated` and the confirmation rate is `confirmed / emitted`,
 * both computed at read time so a stored third number cannot drift away from
 * the two it came from.
 *
 * THIS IS A PROTOTYPE SEAM, NOT THE PRODUCTION SHAPE. The counts live here in a
 * side table keyed by `externalInvocationId` because the fixture and
 * `SessionTraceInvocation` are owned elsewhere and are being rebuilt concurrently. In
 * production `findingsEmitted` and `findingsInvalidated` are columns on the
 * invocation row itself, read off the span like every other field, and this
 * module collapses to the derivations and the formatters below.
 *
 * KEYED DEFENSIVELY, for that same reason. An id the ledger has never heard of
 * degrades to "no findings reported", never to zero, and never throws.
 *
 * UNKNOWN IS NOT ZERO. Most spans produce no findings at all: a `Bash`, a
 * `Read`, a hook. Those have NO entry and every surface renders nothing for
 * them. A component that reported `emitted: 0` is a different fact, it looked
 * and found nothing, and it renders. Same discipline `SessionTraceExtentSource`
 * already holds for bar widths.
 *
 * A RATE CARRIES ITS POPULATION. The session rate is over the components that
 * report findings, never over every span, so it is published as
 * "71% across 2 reporting components". Folding the silent majority into the
 * denominator would make the number mean nothing.
 */

import type {
  SessionTraceInvocation,
  SessionTraceSpan,
} from "../../../../lib/session-trace/session-trace-node";

/** The two stored counts. Everything else here is derived from them. */
export type PreviewFindingsFunnel = {
  findingsEmitted: number;
  findingsInvalidated: number;
};

/**
 * A funnel plus its derivations, over one invocation or over a set of them.
 *
 * `reportingInvocationCount` travels with the totals so a sum always says how
 * many invocations it is a sum OVER, the same reason `measuredOccurrenceCount`
 * rides beside `measuredMs` in the component drill-in.
 */
export type PreviewFindingsTotals = PreviewFindingsFunnel & {
  findingsConfirmed: number;
  reportingInvocationCount: number;
};

/** Session-grain totals, with the population the rate is true of. */
export type PreviewFindingsPopulation = PreviewFindingsTotals & {
  reportingComponentCount: number;
};

/**
 * The seeded ledger. Only the reviewing components in the traced session have
 * an entry; every other invocation is deliberately absent, which is what
 * exercises the unknown-is-not-zero rule on every surface.
 */
export const PREVIEW_FINDINGS_LEDGER: Readonly<
  Record<string, PreviewFindingsFunnel>
> = {
  /** design-critic, the prototype review pass. */
  n14: { findingsEmitted: 11, findingsInvalidated: 4 },
  /** visual-qa, the production review pass. */
  n22: { findingsEmitted: 6, findingsInvalidated: 1 },
};

/** The funnel for one invocation, or undefined when it reports no findings. */
export function previewFindingsFor(
  invocation: Pick<SessionTraceInvocation, "externalInvocationId">
): PreviewFindingsFunnel | undefined {
  const { externalInvocationId } = invocation;
  if (!Object.hasOwn(PREVIEW_FINDINGS_LEDGER, externalInvocationId)) {
    return undefined;
  }
  return PREVIEW_FINDINGS_LEDGER[externalInvocationId];
}

/**
 * Sum a set of funnels. Returns undefined for an empty set, because "nothing in
 * scope reports findings" and "everything in scope found nothing" are different
 * facts and every caller renders them differently.
 */
export function totalPreviewFindings(
  funnels: Iterable<PreviewFindingsFunnel>
): PreviewFindingsTotals | undefined {
  let findingsEmitted = 0;
  let findingsInvalidated = 0;
  let reportingInvocationCount = 0;
  for (const funnel of funnels) {
    findingsEmitted += funnel.findingsEmitted;
    findingsInvalidated += funnel.findingsInvalidated;
    reportingInvocationCount += 1;
  }
  if (reportingInvocationCount === 0) {
    return undefined;
  }
  return {
    findingsEmitted,
    findingsInvalidated,
    findingsConfirmed: findingsEmitted - findingsInvalidated,
    reportingInvocationCount,
  };
}

/** Every funnel at or under `span`, in tree order. */
export function collectSubtreeFindings(
  span: SessionTraceSpan
): readonly PreviewFindingsFunnel[] {
  const collected: PreviewFindingsFunnel[] = [];
  const own = previewFindingsFor(span.invocation);
  if (own !== undefined) {
    collected.push(own);
  }
  for (const child of span.children) {
    collected.push(...collectSubtreeFindings(child));
  }
  return collected;
}

/**
 * The fleet's totals under one node. An `Agent` row above a reviewer fan-out
 * reports what the whole fan-out found, so a collapsed parent still carries it.
 */
export function rollUpPreviewFindings(
  span: SessionTraceSpan
): PreviewFindingsTotals | undefined {
  return totalPreviewFindings(collectSubtreeFindings(span));
}

/** Totals across a set of spans, without descending. The component drill-in. */
export function collectSpanFindings(
  spans: readonly SessionTraceSpan[]
): PreviewFindingsTotals | undefined {
  const funnels: PreviewFindingsFunnel[] = [];
  for (const span of spans) {
    const funnel = previewFindingsFor(span.invocation);
    if (funnel !== undefined) {
      funnels.push(funnel);
    }
  }
  return totalPreviewFindings(funnels);
}

/**
 * Session totals plus the number of distinct components behind them. Works off
 * the flat invocation list rather than the tree, because every invocation is in
 * it whether or not the derivation could place it on the axis: a reviewer with
 * no timestamp still found what it found.
 */
export function summarisePreviewFindings(
  invocations: readonly SessionTraceInvocation[]
): PreviewFindingsPopulation | undefined {
  const funnels: PreviewFindingsFunnel[] = [];
  const reportingComponents = new Set<string>();
  for (const invocation of invocations) {
    const funnel = previewFindingsFor(invocation);
    if (funnel !== undefined) {
      funnels.push(funnel);
      reportingComponents.add(`${invocation.kind}:${invocation.componentKey}`);
    }
  }
  const totals = totalPreviewFindings(funnels);
  if (totals === undefined) {
    return undefined;
  }
  return { ...totals, reportingComponentCount: reportingComponents.size };
}

/**
 * Confirmed over emitted, 0..1. Undefined when nothing was emitted: a component
 * that looked and found nothing has no rate, and a printed 0% would read as
 * "everything it found was thrown out".
 */
export function previewConfirmationRate(
  totals: PreviewFindingsTotals
): number | undefined {
  if (totals.findingsEmitted <= 0) {
    return undefined;
  }
  return totals.findingsConfirmed / totals.findingsEmitted;
}

/** `64%`, or an em dash when nothing was emitted to have a rate over. */
export function formatPreviewConfirmationRate(
  totals: PreviewFindingsTotals
): string {
  const rate = previewConfirmationRate(totals);
  if (rate === undefined) {
    return "—";
  }
  return `${Math.round(rate * 100)}%`;
}

/**
 * `11 findings, 4 invalidated`. Reads BESIDE a spend figure and is never
 * divided into it: the tokens behind one finding are not separable from the
 * rest of the turn, so a dollars-per-finding number would be invented.
 */
export function formatPreviewFindingsCounts(
  funnel: PreviewFindingsFunnel
): string {
  const findings =
    funnel.findingsEmitted === 1
      ? "1 finding"
      : `${funnel.findingsEmitted} findings`;
  return `${findings}, ${funnel.findingsInvalidated} invalidated`;
}

/** `across 2 reporting components`. The session rate never travels without it. */
export function formatPreviewReportingPopulation(
  population: PreviewFindingsPopulation
): string {
  const count = population.reportingComponentCount;
  return `across ${count} reporting component${count === 1 ? "" : "s"}`;
}

/** `across 3 invocations`. The component drill-in's population. */
export function formatPreviewReportingInvocations(
  totals: PreviewFindingsTotals
): string {
  const count = totals.reportingInvocationCount;
  return `across ${count} invocation${count === 1 ? "" : "s"}`;
}
