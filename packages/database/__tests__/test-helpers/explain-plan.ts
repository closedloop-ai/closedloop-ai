/**
 * Readers for `EXPLAIN (ANALYZE …)` output, for the migration index guards.
 *
 * WHY THESE THROW (ISS-6211): the index guards assert an UPPER BOUND on a plan
 * metric — "the scan must not walk the organization's whole partition, so at
 * most N rows may be discarded". An upper bound is only meaningful when the
 * metric was actually read. The first version of the ISS-6104 guard defaulted a
 * missing `Rows Removed by Filter` line to `0`, which made
 * `expect(0).toBeLessThanOrEqual(32)` pass for EVERY plan that never reported
 * the metric — including the regressed plan the guard exists to catch, a plan
 * from a database where the index was never built, and an empty string from an
 * EXPLAIN that returned no rows. A guard that reports green when it could not
 * evaluate is worse than no guard, so every reader here fails closed: an
 * unavailable plan, an absent node, and unparseable output are all errors that
 * name the plan they were read from.
 *
 * These live in a module rather than inside the integration suite so the
 * fail-closed behavior itself is unit-testable without a database — the
 * integration suite is `skipIf(!process.env.DATABASE_URL)` and would otherwise
 * carry its own guard's only proof.
 */

/** PostgreSQL's label for rows a node's `Filter` discarded after the scan. */
export const ROWS_REMOVED_BY_FILTER_LABEL = "Rows Removed by Filter:";

/** PostgreSQL's label for the predicate an index scan pushed into the index. */
export const INDEX_COND_LABEL = "Index Cond:";

const NON_NEGATIVE_INTEGER_RE = /^\d+$/;

/**
 * The plan text, or an error naming `description` when EXPLAIN produced nothing.
 *
 * An empty plan is the shape an unavailable/failed EXPLAIN takes, and every
 * downstream `toContain`/bound assertion reads vacuously against it.
 */
export function requireNonEmptyPlan(plan: string, description: string): string {
  if (plan.trim() === "") {
    throw new Error(
      `${description}: EXPLAIN returned no plan text. The assertions below are upper bounds and would pass vacuously against an empty plan, so this fails closed instead. Check that the query ran and that EXPLAIN output was collected from the first column of every returned row.`
    );
  }
  return plan;
}

/**
 * The one plan node scanning `relation`, reduced to its OWN lines.
 *
 * A plan metric belongs to a node, not to a plan. Reading "the first
 * `Rows Removed by Filter` in the text" binds the assertion to whichever node
 * happens to sort first, so a join, a parallel plan, or an added subquery can
 * silently re-target an upper bound at an unrelated scan — and a plan whose
 * outermost node reports a small number keeps the guard green no matter what
 * the scan under test did. Selecting the node by the relation it reads makes
 * that relationship explicit, and both "no such node" and "more than one such
 * node" fail rather than picking one.
 *
 * The returned block is the node's header plus the detail lines that belong to
 * it, stopping at its first child — a child's metrics are the child's.
 */
export function requireScanNode(plan: string, relation: string): string {
  const lines = plan.split("\n");
  const headers = nodeHeaderIndices(lines);
  const start = requireOneScanNode(lines, headers, relation, plan);
  const end = headers.find((index) => index > start) ?? lines.length;
  return lines.slice(start, end).join("\n");
}

/**
 * The `Index Cond:` proving the relation's own index served the lookup.
 *
 * Scoped to the ONE node scanning `relation` and, when that node is a
 * `Bitmap Heap Scan`, to its bitmap-index children — which are the index half
 * of that same scan, over indexes of that same relation. PostgreSQL puts the
 * pushed-down predicate on those children and leaves the heap node carrying
 * `Recheck Cond:`, so reading `Index Cond:` off the heap node alone finds
 * nothing on a perfectly healthy bitmap plan.
 *
 * This deliberately does NOT fall back to searching the whole plan: a join's
 * other relation could then satisfy the assertion. More than one `Index Cond:`
 * in the access path (a `BitmapAnd` over several indexes) is ambiguous and
 * throws rather than picking one.
 */
export function requireIndexPredicate(plan: string, relation: string): string {
  const lines = plan.split("\n");
  const headers = nodeHeaderIndices(lines);
  const start = requireOneScanNode(lines, headers, relation, plan);
  const accessPath = lines.slice(start, accessPathEnd(lines, headers, start));
  const matches = accessPath.filter((line) => line.includes(INDEX_COND_LABEL));
  if (matches.length === 0) {
    throw new Error(
      `The scan of "${relation}" exposes no "${INDEX_COND_LABEL}" anywhere in its access path, so there is no evidence the predicate was pushed into an index and this fails closed.\nAccess path:\n${accessPath.join("\n")}\nPlan:\n${plan}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `The access path for "${relation}" exposes ${matches.length} "${INDEX_COND_LABEL}" lines (a BitmapAnd/BitmapOr over several indexes), so which one the assertion describes is ambiguous and this fails closed rather than picking one.\nAccess path:\n${accessPath.join("\n")}`
    );
  }
  return matches[0];
}

/**
 * The first plan line carrying `label`, or an error embedding the whole plan.
 *
 * Never returns `""` for an absent node: a `toContain` against `""` fails with
 * a message about the substring rather than about the missing plan node, and a
 * numeric read of `""` is what produced the ISS-6211 fail-open.
 *
 * Rejects text spanning more than one plan node, so a caller cannot read a
 * node-scoped metric off a whole plan and get whichever node came first.
 */
export function requirePlanLine(plan: string, label: string): string {
  requireSingleNode(plan, label);
  const line = plan.split("\n").find((candidate) => candidate.includes(label));
  if (line === undefined) {
    throw new Error(
      `Plan node "${label}" is absent, so the assertion on it cannot be evaluated and fails closed rather than defaulting.\nRead the plan below and pick the remedy: (a) the planner regressed to a worse plan — fix the index or the query; or (b) the planner chose a plan that is at least as good and simply had nothing to report, because EXPLAIN's text format omits a zero instrumentation count — in that case re-target the assertion at the node the new plan does expose rather than relaxing it back to a default.\nPlan:\n${plan}`
    );
  }
  return line;
}

/**
 * `Rows Removed by Filter` for the first node reporting it.
 *
 * Fails closed on an absent line and on a value that is not a bare
 * non-negative integer — `Number.parseInt` would silently accept `"32 abc"`
 * and reduce a truncated or reformatted plan to a passing number.
 */
export function requireRowsRemovedByFilter(plan: string): number {
  const line = requirePlanLine(plan, ROWS_REMOVED_BY_FILTER_LABEL);
  const raw = line
    .slice(
      line.indexOf(ROWS_REMOVED_BY_FILTER_LABEL) +
        ROWS_REMOVED_BY_FILTER_LABEL.length
    )
    .trim();
  if (!NON_NEGATIVE_INTEGER_RE.test(raw)) {
    throw new Error(
      `"${ROWS_REMOVED_BY_FILTER_LABEL}" carried ${JSON.stringify(raw)}, which is not a bare non-negative integer. The metric is asserted as an upper bound, so an unparseable value fails closed instead of being coerced.\nPlan line:\n${line}`
    );
  }
  return Number.parseInt(raw, 10);
}

/** The scan node kind whose index predicate lives on its bitmap-index children. */
const BITMAP_HEAP_SCAN = "Bitmap Heap Scan";

/** The single node scanning `relation`; absent and ambiguous both throw. */
function requireOneScanNode(
  lines: readonly string[],
  headers: readonly number[],
  relation: string,
  plan: string
): number {
  const matched = headers.filter((index) =>
    scansRelation(lines[index], relation)
  );
  if (matched.length === 0) {
    throw new Error(
      `No plan node scans "${relation}", so the assertions on that scan cannot be evaluated and fail closed rather than reading a metric off some other node.\nPlan:\n${plan}`
    );
  }
  if (matched.length > 1) {
    throw new Error(
      `${matched.length} plan nodes scan "${relation}", so which node the assertions describe is ambiguous and this fails closed rather than picking one. Narrow the query, or select the node explicitly.\nPlan:\n${plan}`
    );
  }
  return matched[0];
}

/**
 * Where the relation's index access path ends.
 *
 * A `Bitmap Heap Scan`'s subtree is entirely bitmap-index nodes over the SAME
 * relation, so it belongs to this scan; every other scan kind keeps its
 * predicate on its own lines, and its children are separate relations.
 */
function accessPathEnd(
  lines: readonly string[],
  headers: readonly number[],
  start: number
): number {
  if (!lines[start].includes(BITMAP_HEAP_SCAN)) {
    return headers.find((index) => index > start) ?? lines.length;
  }
  const depth = indentationOf(lines[start]);
  return (
    headers.find(
      (index) => index > start && indentationOf(lines[index]) <= depth
    ) ?? lines.length
  );
}

/** Leading whitespace width, which is how EXPLAIN's text form encodes depth. */
function indentationOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** `->` starts every child node; the first non-blank line is the root node. */
function nodeHeaderIndices(lines: readonly string[]): number[] {
  const indices: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    if (indices.length === 0 || line.trimStart().startsWith("->")) {
      indices.push(index);
    }
  }
  return indices;
}

/**
 * Whether a node header reads `relation`.
 *
 * Anchored on the `on <relation>` clause and bounded at the end so
 * `agent_components` cannot be satisfied by `agent_components_archive`.
 */
function scansRelation(header: string, relation: string): boolean {
  const marker = ` on ${relation}`;
  const at = header.indexOf(marker);
  if (at === -1) {
    return false;
  }
  const next = header.charAt(at + marker.length);
  return next === "" || next === " ";
}

/** Refuses text covering more than one node, so a metric read stays scoped. */
function requireSingleNode(plan: string, label: string): void {
  const headers = nodeHeaderIndices(plan.split("\n"));
  if (headers.length > 1) {
    throw new Error(
      `"${label}" was read from text spanning ${headers.length} plan nodes, so the value returned would be whichever node sorts first rather than the node under test. Scope the read with \`requireScanNode\` first.\nPlan:\n${plan}`
    );
  }
}
