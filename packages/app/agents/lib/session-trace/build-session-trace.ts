/**
 * @file build-session-trace.ts
 * @description Flat invocation rows -> the placed span tree the Trace chart draws.
 *
 * THE DERIVATION THIS FILE OWNS, AND WHAT IT REFUSES TO DO. An invocation row
 * carries a start instant and, sometimes, a measured elapsed span. It never
 * carries an end. So an end is either measured or reasoned to, and the two are
 * not the same claim: a reasoned end says "this call had not yet given way to
 * its sibling", which is an UPPER BOUND on its latency. Every span records which
 * it got ({@link SessionTraceExtentSource}) and the chart renders the two differently,
 * because a reader who cannot tell them apart will read the second as latency.
 *
 * Nothing here discards a row. An invocation with no timestamp cannot be put on
 * the axis, so it goes to `unplaced` with its ordinal intact rather than being
 * filtered out — it happened, and the trace is evidence of that whether or not
 * its instant survived collection.
 */

import {
  type SessionTrace,
  SessionTraceExtentSource,
  type SessionTraceInvocation,
  type SessionTraceSpan,
} from "./session-trace-node";

type MutableSpan = Omit<SessionTraceSpan, "children" | "onCriticalPath"> & {
  children: MutableSpan[];
  onCriticalPath: boolean;
};

type Interval = { start: number; end: number };

/**
 * A node whose extent could not be bounded by a sibling, a parent, or a measured
 * duration still has to occupy something, or it vanishes from a chart that is
 * supposed to prove it ran. It gets this floor, and `Inferred` says the width is
 * not a measurement.
 */
const UNBOUNDED_INFERRED_FLOOR_MS = 1;

export function buildSessionTrace(
  invocations: readonly SessionTraceInvocation[]
): SessionTrace {
  const ordered = [...invocations].sort(
    (left, right) => left.sequence - right.sequence
  );
  // `invokedAt` is an arbitrary string once it is non-null, so a row that
  // carries one the clock cannot read is no better placed than a row that
  // carries none: `Date.parse` hands back NaN, and one NaN poisons the origin,
  // the bound, and every bar drawn against them. An unreadable instant is
  // treated exactly like an absent one — unplaced, never dropped.
  const placed: SessionTraceInvocation[] = [];
  const unplaced: SessionTraceInvocation[] = [];
  const instants = new Map<string, number>();
  for (const row of ordered) {
    const instantMs =
      row.invokedAt === null ? Number.NaN : Date.parse(row.invokedAt);
    if (Number.isFinite(instantMs)) {
      placed.push(row);
      instants.set(row.externalInvocationId, instantMs);
      continue;
    }
    unplaced.push(row);
  }

  if (placed.length === 0) {
    return emptyTrace(unplaced);
  }

  const originMs = Math.min(...instants.values());
  const lastStartMs = Math.max(...instants.values());

  const nodes = new Map<string, MutableSpan>();
  for (const row of placed) {
    nodes.set(row.externalInvocationId, {
      invocation: row,
      depth: 0,
      ancestry: [],
      startMs: (instants.get(row.externalInvocationId) ?? originMs) - originMs,
      endMs: 0,
      extentSource: SessionTraceExtentSource.Inferred,
      selfMs: 0,
      subtreeMs: 0,
      subtreeCostUsd: 0,
      subtreeFootprintTokens: 0,
      subtreeInputTokens: 0,
      subtreeOutputTokens: 0,
      subtreeErrorCount: 0,
      onCriticalPath: false,
      children: [],
    });
  }

  const roots = linkParents(nodes);
  // A root with no measured duration and no later sibling has nothing to close
  // it, so the trace's own last observed instant is the outer bound.
  const traceBound = lastStartMs - originMs + UNBOUNDED_INFERRED_FLOOR_MS;

  for (const root of roots) {
    assignHierarchy(root);
  }
  resolveGroupExtents(roots, traceBound, traceBound);
  markCriticalPath(roots);

  return finishTrace(roots, unplaced, originMs, traceBound);
}

/**
 * Attach every node to its parent and return the nodes with no resolvable parent.
 *
 * A PARENT CYCLE IS CUT RATHER THAN OBEYED. `parentExternalInvocationId` is a
 * collected field, so a corrupt pair can point at each other; obeying that gives
 * the tree NO root at all, and the tab then draws an empty trace for a session
 * that ran — an empty render standing in for bad data, which is the one thing
 * this surface must never do. Every node on a cycle is re-rooted instead, so the
 * rows stay on screen and their broken ancestry is the only thing lost.
 */
function linkParents(nodes: Map<string, MutableSpan>): MutableSpan[] {
  const cyclic = findCyclicNodes(nodes);
  const roots: MutableSpan[] = [];
  for (const node of nodes.values()) {
    const parentId = node.invocation.parentExternalInvocationId;
    const parent =
      parentId === undefined || cyclic.has(node.invocation.externalInvocationId)
        ? undefined
        : nodes.get(parentId);
    if (parent === undefined) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }
  for (const node of nodes.values()) {
    node.children.sort((left, right) => left.startMs - right.startMs);
  }
  roots.sort((left, right) => left.startMs - right.startMs);
  return roots;
}

/**
 * The ids that sit ON a parent cycle.
 *
 * Only the cycle members are named, not their descendants: once a member is
 * re-rooted the chain below it terminates, so a descendant keeps the ancestry it
 * genuinely has. Iterative, and each node is resolved once, so a 100,000-row
 * page is a linear pass and not a stack of 100,000 frames.
 */
function findCyclicNodes(nodes: Map<string, MutableSpan>): Set<string> {
  const cyclic = new Set<string>();
  const settled = new Set<string>();
  for (const start of nodes.values()) {
    if (settled.has(start.invocation.externalInvocationId)) {
      continue;
    }
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: MutableSpan | undefined = start;
    while (cursor !== undefined) {
      const id = cursor.invocation.externalInvocationId;
      if (settled.has(id)) {
        break;
      }
      if (onPath.has(id)) {
        for (const member of path.slice(path.indexOf(id))) {
          cyclic.add(member);
        }
        break;
      }
      path.push(id);
      onPath.add(id);
      // Annotated: without it `cursor` is inferred from an initializer that
      // references `cursor` itself (TS7022).
      const parentId: string | undefined =
        cursor.invocation.parentExternalInvocationId;
      cursor = parentId === undefined ? undefined : nodes.get(parentId);
    }
    for (const id of path) {
      settled.add(id);
    }
  }
  return cyclic;
}

/**
 * Depth and ancestry for every node under one root.
 *
 * Iterative: the walk is over collected data whose depth this code does not
 * bound, and a recursive descent over a long parent chain overflows the browser
 * stack — which takes the whole tab down rather than degrading.
 */
function assignHierarchy(root: MutableSpan): void {
  const stack: {
    node: MutableSpan;
    depth: number;
    ancestry: readonly string[];
  }[] = [{ node: root, depth: 0, ancestry: [] }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    frame.node.depth = frame.depth;
    frame.node.ancestry = frame.ancestry;
    const childAncestry = [
      ...frame.ancestry,
      frame.node.invocation.componentKey,
    ];
    for (const child of frame.node.children) {
      stack.push({
        node: child,
        depth: frame.depth + 1,
        ancestry: childAncestry,
      });
    }
  }
}

/**
 * Resolve every span's extent, outermost group first.
 *
 * Each node is bounded by whichever comes first: its own measured duration, the
 * next sibling's start, or the parent's close. A parent is then widened to cover
 * any child that outlived the bound, so no child is ever drawn outside the span
 * that owns it — which is why a node is finalised only AFTER its children are.
 *
 * Driven by an explicit stack rather than recursion, for the same reason
 * {@link assignHierarchy} is: nothing here bounds the depth of collected data,
 * and a stack overflow takes the tab down instead of degrading.
 */
type ExtentTask =
  | {
      kind: "enter";
      node: MutableSpan;
      nextSiblingStart: number | undefined;
      parentEndBound: number;
    }
  | { kind: "exit"; node: MutableSpan; provisionalEnd: number };

function resolveGroupExtents(
  siblings: readonly MutableSpan[],
  parentEndBound: number,
  traceBound: number
): void {
  const stack: ExtentTask[] = [];
  pushExtentGroup(stack, siblings, parentEndBound);
  while (stack.length > 0) {
    const task = stack.pop();
    if (task === undefined) {
      break;
    }
    if (task.kind === "exit") {
      finaliseExtent(task.node, task.provisionalEnd);
      continue;
    }
    const provisionalEnd = provisionalEndFor(
      task.node,
      task.nextSiblingStart,
      task.parentEndBound,
      traceBound
    );
    stack.push({ kind: "exit", node: task.node, provisionalEnd });
    pushExtentGroup(stack, task.node.children, provisionalEnd);
  }
}

/** One sibling group onto the work stack. Siblings resolve independently. */
function pushExtentGroup(
  stack: ExtentTask[],
  siblings: readonly MutableSpan[],
  parentEndBound: number
): void {
  for (let index = siblings.length - 1; index >= 0; index -= 1) {
    const node = siblings[index];
    if (node === undefined) {
      continue;
    }
    stack.push({
      kind: "enter",
      node,
      nextSiblingStart: siblings[index + 1]?.startMs,
      parentEndBound,
    });
  }
}

function finaliseExtent(node: MutableSpan, provisionalEnd: number): void {
  node.endMs = Math.max(provisionalEnd, latestChildEnd(node));
  node.subtreeMs = node.endMs - node.startMs;
  node.selfMs = Math.max(
    0,
    node.subtreeMs - unionLength(node.children.map(toInterval))
  );
  rollUpSubtree(node);
}

/**
 * Subtree totals, each kept in its own population.
 *
 * Turn tokens and footprint tokens are NOT added together anywhere: a
 * component's injected text is already inside the consuming turn's
 * `inputTokens`, so one number is an attribution of the other, not an addition
 * to it. They travel as separate fields for the same reason the UI gives them
 * separate columns.
 */
function rollUpSubtree(node: MutableSpan): void {
  const own = node.invocation;
  let costUsd = own.estimatedCost ?? 0;
  let footprint = own.footprintTokens ?? 0;
  let input = own.inputTokens ?? 0;
  let output = own.outputTokens ?? 0;
  let errors = own.succeeded === false ? 1 : 0;

  for (const child of node.children) {
    costUsd += child.subtreeCostUsd;
    footprint += child.subtreeFootprintTokens;
    input += child.subtreeInputTokens;
    output += child.subtreeOutputTokens;
    errors += child.subtreeErrorCount;
  }

  node.subtreeCostUsd = costUsd;
  node.subtreeFootprintTokens = footprint;
  node.subtreeInputTokens = input;
  node.subtreeOutputTokens = output;
  node.subtreeErrorCount = errors;
}

function provisionalEndFor(
  node: MutableSpan,
  nextSiblingStart: number | undefined,
  parentEndBound: number,
  traceBound: number
): number {
  const measured = node.invocation.durationMs;
  if (measured !== undefined && Number.isFinite(measured) && measured >= 0) {
    node.extentSource = SessionTraceExtentSource.Measured;
    return node.startMs + measured;
  }
  node.extentSource = SessionTraceExtentSource.Inferred;
  const bound = Math.min(
    nextSiblingStart ?? Number.POSITIVE_INFINITY,
    parentEndBound,
    traceBound
  );
  return Math.max(node.startMs + UNBOUNDED_INFERRED_FLOOR_MS, bound);
}

function latestChildEnd(node: MutableSpan): number {
  let latest = node.startMs;
  for (const child of node.children) {
    latest = Math.max(latest, child.endMs);
  }
  return latest;
}

function toInterval(node: MutableSpan): Interval {
  return { start: node.startMs, end: node.endMs };
}

/**
 * Total time covered by at least one interval. Siblings genuinely overlap when a
 * lane fans out, so summing child durations would overstate what the parent's
 * own time was spent on — self time has to come off the UNION.
 */
function unionLength(intervals: readonly Interval[]): number {
  if (intervals.length === 0) {
    return 0;
  }
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  let covered = 0;
  let windowStart = sorted[0].start;
  let windowEnd = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start > windowEnd) {
      covered += windowEnd - windowStart;
      windowStart = interval.start;
      windowEnd = interval.end;
      continue;
    }
    windowEnd = Math.max(windowEnd, interval.end);
  }
  return covered + (windowEnd - windowStart);
}

/**
 * The chain that ATE the session: start at the longest-running root, then
 * descend into whichever child ran longest, repeatedly.
 *
 * Deliberately longest-running and NOT latest-finishing. A session's roots are
 * usually sequential, so "finished last" resolves to whatever happened to come
 * last — on the reference session that is a 3 ms `ScheduleWakeup`, which is a
 * true statement about ordering and a useless answer to "why did this take 62
 * minutes". Descending by duration answers the question actually being asked:
 * on that session it walks `/design` -> `design` -> `Agent` -> `design-critic`
 * -> `local-ci` and lands five levels below the root command on the 690-second
 * `dagger call check` retry that really did hold the session open. This is the
 * one thing a flat metric stream can never answer.
 */
function markCriticalPath(roots: readonly MutableSpan[]): void {
  let cursor = longestRunning(roots);
  while (cursor !== undefined) {
    cursor.onCriticalPath = true;
    cursor = longestRunning(cursor.children);
  }
}

function longestRunning(
  candidates: readonly MutableSpan[]
): MutableSpan | undefined {
  let longest: MutableSpan | undefined;
  for (const candidate of candidates) {
    if (longest === undefined || candidate.subtreeMs > longest.subtreeMs) {
      longest = candidate;
    }
  }
  return longest;
}

function emptyTrace(unplaced: readonly SessionTraceInvocation[]): SessionTrace {
  return {
    roots: [],
    unplaced,
    originMs: 0,
    totalMs: 0,
    maxDepth: 0,
    spanCount: 0,
    agentCount: 0,
    measuredSpanCount: 0,
    inferredSpanCount: 0,
    errorCount: 0,
    totalFootprintTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    succeededReportedCount: 0,
    durationReportedCount: 0,
    costReportedCount: 0,
    footprintReportedCount: 0,
    turnTokenReportedCount: 0,
  };
}

/** Totals over an arbitrary span set, so a focused subtree can describe itself. */
export type SessionTraceSpanSummary = {
  spanCount: number;
  maxDepth: number;
  agentCount: number;
  wallClockMs: number;
  costUsd: number;
  footprintTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  measuredSpanCount: number;
  inferredSpanCount: number;
  errorCount: number;
};

/**
 * Summarise whatever the chart is currently drawing.
 *
 * The header exists to answer "what did THIS cost", so it has to be computed
 * from the same population the chart shows. Focusing a subtree and leaving the
 * header on session totals describes a population the reader can no longer see,
 * which is the header contradicting the chart underneath it. The same holds one
 * filter down: the kind, error, critical-path and window lenses all narrow what
 * is drawn, so this takes the ALREADY-NARROWED row list rather than a tree it
 * would re-expand — a caller handing it roots would silently re-admit every
 * descendant the lenses had just removed.
 */
export function summariseSessionTraceSpans(
  spans: readonly SessionTraceSpan[]
): SessionTraceSpanSummary {
  const agents = new Set<string>();
  const summary: SessionTraceSpanSummary = {
    spanCount: spans.length,
    maxDepth: 0,
    agentCount: 0,
    wallClockMs: 0,
    costUsd: 0,
    footprintTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    measuredSpanCount: 0,
    inferredSpanCount: 0,
    errorCount: 0,
  };

  // Depth is reported RELATIVE to what is drawn: a focused subtree's own root is
  // level 1 of the thing on screen, not level 8 of a tree that is not there.
  const baseDepth =
    spans.length === 0 ? 0 : Math.min(...spans.map((span) => span.depth));
  const earliest =
    spans.length === 0 ? 0 : Math.min(...spans.map((span) => span.startMs));
  for (const span of spans) {
    const { invocation } = span;
    summary.maxDepth = Math.max(summary.maxDepth, span.depth - baseDepth);
    summary.wallClockMs = Math.max(summary.wallClockMs, span.endMs - earliest);
    summary.costUsd += invocation.estimatedCost ?? 0;
    summary.footprintTokens += invocation.footprintTokens ?? 0;
    summary.inputTokens += invocation.inputTokens ?? 0;
    summary.outputTokens += invocation.outputTokens ?? 0;
    summary.cacheReadTokens += invocation.cacheReadTokens ?? 0;
    if (span.extentSource === SessionTraceExtentSource.Measured) {
      summary.measuredSpanCount += 1;
    }
    if (span.extentSource === SessionTraceExtentSource.Inferred) {
      summary.inferredSpanCount += 1;
    }
    if (invocation.succeeded === false) {
      summary.errorCount += 1;
    }
    if (invocation.externalAgentId !== undefined) {
      agents.add(invocation.externalAgentId);
    }
  }
  summary.agentCount = agents.size;
  return summary;
}

/**
 * The running totals `finishTrace` accumulates, split out so the walk body stays
 * one statement. The reported-counts half exists because "how many rows carry
 * this population at all" is a different question from "what did they sum to",
 * and the disclosure needs the first one to name a missing operand rather than
 * publish a zero.
 */
type SessionTraceTotals = {
  maxDepth: number;
  spanCount: number;
  measuredSpanCount: number;
  inferredSpanCount: number;
  errorCount: number;
  totalMs: number;
  totalFootprintTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  succeededReportedCount: number;
  durationReportedCount: number;
  costReportedCount: number;
  footprintReportedCount: number;
  turnTokenReportedCount: number;
};

function emptyTotals(): SessionTraceTotals {
  return {
    maxDepth: 0,
    spanCount: 0,
    measuredSpanCount: 0,
    inferredSpanCount: 0,
    errorCount: 0,
    totalMs: 0,
    totalFootprintTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    succeededReportedCount: 0,
    durationReportedCount: 0,
    costReportedCount: 0,
    footprintReportedCount: 0,
    turnTokenReportedCount: 0,
  };
}

function accumulateExtent(totals: SessionTraceTotals, span: SessionTraceSpan) {
  totals.spanCount += 1;
  totals.maxDepth = Math.max(totals.maxDepth, span.depth);
  totals.totalMs = Math.max(totals.totalMs, span.endMs);
  if (span.extentSource === SessionTraceExtentSource.Measured) {
    totals.measuredSpanCount += 1;
  }
  if (span.extentSource === SessionTraceExtentSource.Inferred) {
    totals.inferredSpanCount += 1;
  }
}

function accumulateTelemetry(
  totals: SessionTraceTotals,
  invocation: SessionTraceInvocation
) {
  totals.totalFootprintTokens += invocation.footprintTokens ?? 0;
  totals.totalInputTokens += invocation.inputTokens ?? 0;
  totals.totalOutputTokens += invocation.outputTokens ?? 0;
  totals.totalCacheReadTokens += invocation.cacheReadTokens ?? 0;
  if (invocation.succeeded === false) {
    totals.errorCount += 1;
  }
  if (invocation.succeeded !== undefined) {
    totals.succeededReportedCount += 1;
  }
  if (invocation.durationMs !== undefined) {
    totals.durationReportedCount += 1;
  }
  if (invocation.estimatedCost !== undefined) {
    totals.costReportedCount += 1;
  }
  if (invocation.footprintTokens !== undefined) {
    totals.footprintReportedCount += 1;
  }
  if (
    invocation.inputTokens !== undefined ||
    invocation.outputTokens !== undefined
  ) {
    totals.turnTokenReportedCount += 1;
  }
}

function finishTrace(
  roots: readonly MutableSpan[],
  unplaced: readonly SessionTraceInvocation[],
  originMs: number,
  traceBound: number
): SessionTrace {
  const totals = emptyTotals();
  const agents = new Set<string>();

  forEachSpan(roots, (span) => {
    accumulateExtent(totals, span);
    accumulateTelemetry(totals, span.invocation);
    if (span.invocation.externalAgentId !== undefined) {
      agents.add(span.invocation.externalAgentId);
    }
  });

  return {
    ...totals,
    roots: roots as readonly SessionTraceSpan[],
    unplaced,
    originMs,
    totalMs: Math.max(totals.totalMs, traceBound),
    agentCount: agents.size,
  };
}

/**
 * Depth-first walk over a placed span tree, parents before their children.
 *
 * Iterative for the same reason the derivation's own walks are: a deep tree must
 * not be able to overflow the browser stack from inside a render.
 */
export function forEachSpan(
  spans: readonly SessionTraceSpan[],
  visit: (span: SessionTraceSpan) => void
): void {
  const stack: SessionTraceSpan[] = [];
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    if (span !== undefined) {
      stack.push(span);
    }
  }
  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) {
      break;
    }
    visit(span);
    for (let index = span.children.length - 1; index >= 0; index -= 1) {
      const child = span.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
}

/** Every placed span, flattened in draw order (parents before their children). */
export function flattenSpans(
  spans: readonly SessionTraceSpan[]
): SessionTraceSpan[] {
  const flat: SessionTraceSpan[] = [];
  forEachSpan(spans, (span) => flat.push(span));
  return flat;
}

/** Locate one span by its invocation id, for deep-link restore. */
export function findSpanById(
  spans: readonly SessionTraceSpan[],
  externalInvocationId: string
): SessionTraceSpan | undefined {
  return flattenSpans(spans).find(
    (span) => span.invocation.externalInvocationId === externalInvocationId
  );
}

export type SessionTraceDrawnSpanFilter = {
  /** Visible window, in ms from the trace origin. */
  windowFromMs: number;
  windowToMs: number;
  showCriticalPathOnly: boolean;
};

/**
 * The rows the chart will actually draw, out of the rows the kind and error
 * lenses already left standing.
 *
 * This is the LAST narrowing, and it lives here rather than inside
 * `SessionTraceChartRows` so the header can be summarised over its result. A
 * filter a component applies privately is a population only that component
 * knows about, and every number above the chart then describes rows the reader
 * cannot see.
 */
export function selectDrawnSpans(
  spans: readonly SessionTraceSpan[],
  {
    windowFromMs,
    windowToMs,
    showCriticalPathOnly,
  }: SessionTraceDrawnSpanFilter
): SessionTraceSpan[] {
  return spans.filter(
    (span) =>
      (!showCriticalPathOnly || span.onCriticalPath) &&
      span.endMs >= windowFromMs &&
      span.startMs <= windowToMs
  );
}

/**
 * Every placed span that reported a failure, in session order.
 *
 * SESSION ORDER, NOT DRAW ORDER. The list this feeds is a drill-down's entry
 * point — you arrive from an error pattern seen across many sessions, and the
 * question is WHERE in this one it happened. Sequence is the order the calls
 * actually ran in, which is the order that reads as a story; draw order would
 * interleave a late failure under an early parent.
 *
 * TIEBROKEN ON `externalInvocationId`. `sequence` is NOT unique: the invocation
 * table's only uniqueness is `@@unique([generationId, externalInvocationId])`
 * and `(generationId, sequence)` is a plain index
 * (`packages/database/prisma/schema.prisma`), so two invocations in one
 * generation can share a `sequence`. Without the second key the comparator
 * returns 0 for two distinct rows and leaves them in input order.
 */
export function collectFailedSpans(
  spans: readonly SessionTraceSpan[]
): readonly SessionTraceSpan[] {
  return flattenSpans(spans)
    .filter((span) => span.invocation.succeeded === false)
    .sort(
      (left, right) =>
        left.invocation.sequence - right.invocation.sequence ||
        left.invocation.externalInvocationId.localeCompare(
          right.invocation.externalInvocationId
        )
    );
}
