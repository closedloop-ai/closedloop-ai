import { describe, expect, it } from "vitest";
import {
  INDEX_COND_LABEL,
  ROWS_REMOVED_BY_FILTER_LABEL,
  requireIndexPredicate,
  requireNonEmptyPlan,
  requirePlanLine,
  requireRowsRemovedByFilter,
  requireScanNode,
} from "./test-helpers/explain-plan";

/**
 * ISS-6211 — the fail-closed proof for the EXPLAIN readers used by the
 * migration index guards.
 *
 * The guards live in `__tests__/integration/`, which is
 * `skipIf(!process.env.DATABASE_URL)` and excluded from `pnpm test:unit`. If
 * their fail-closed behavior were only exercised there, the proof that the
 * guard fails closed would itself be skipped on every run that lacks a
 * database — the same vacuous green the readers exist to prevent. So the
 * readers are driven here, directly, against the malformed plan text a real
 * EXPLAIN can produce: an unavailable plan, a plan missing the expected node,
 * and unparseable metric output.
 *
 * The bound these feed is `<= 32`. Every case below would have SATISFIED that
 * bound under the previous `?? 0` / `Number.parseInt` implementation.
 */

/** The plan the guard is written to accept: index scan, metric present. */
const HEALTHY_PLAN = [
  "Index Scan using agent_components_org_pack_id_idx on agent_components",
  "  Index Cond: ((organization_id = $1) AND (pack_id = ANY ($2)))",
  "  Filter: ((component_kind = ANY ($3)) AND (component_key IS NOT NULL))",
  "  Rows Removed by Filter: 32",
].join("\n");

/**
 * The regressed plan ISS-6104 was filed about: the org-only index, the whole
 * partition walked, 2388 rows discarded after the scan.
 */
const REGRESSED_PLAN = [
  "Index Scan using agent_components_organization_id_idx on agent_components",
  "  Index Cond: (organization_id = $1)",
  "  Filter: (pack_id = ANY ($2))",
  "  Rows Removed by Filter: 2388",
].join("\n");

/**
 * A plan that reports no `Rows Removed by Filter` at all — a seq scan chosen
 * because the index was never built. Under the `?? 0` default this read as
 * "0 rows discarded" and passed the `<= 32` bound.
 */
const PLAN_WITHOUT_METRIC = [
  "Seq Scan on agent_components",
  "  Filter: ((organization_id = $1) AND (pack_id = ANY ($2)))",
].join("\n");

const NO_PLAN_TEXT_RE = /EXPLAIN returned no plan text/;
const CASE_NAME_RE = /zero-match join/;
const INDEX_COND_ABSENT_RE = /Plan node "Index Cond:" is absent/;
const ROWS_REMOVED_ABSENT_RE = /Plan node "Rows Removed by Filter:" is absent/;
const SEQ_SCAN_RE = /Seq Scan on agent_components/;
const NOT_BARE_INTEGER_RE = /is not a bare non-negative integer/;
const SPANNING_NODES_RE = /spanning 3 plan nodes/;
const NO_SCAN_NODE_RE = /No plan node scans/;
const AMBIGUOUS_SCAN_NODE_RE = /plan nodes scan "agent_components"/;
const NO_INDEX_COND_RE = /exposes no "Index Cond:" anywhere in its access path/;
const AMBIGUOUS_INDEX_COND_RE = /exposes 2 "Index Cond:" lines/;

/**
 * A join whose cheap node sorts FIRST and reports 7 while the scan under test
 * sits second and reports 9000. Reading the first metric in the text returned
 * 7 and satisfied every upper bound the guard asserts.
 */
/**
 * The plan CI actually produced (run 31741715430, verbatim). The planner picks
 * a Bitmap Heap Scan, so `Index Cond:` sits on the bitmap-index CHILD and the
 * heap node carries `Recheck Cond:` instead. Scoping the predicate read to the
 * heap node's own lines found nothing and failed a healthy plan closed.
 */
const BITMAP_PLAN = [
  "Bitmap Heap Scan on agent_components (actual rows=0 loops=1)",
  "  Recheck Cond: ((organization_id = '14d8c474'::uuid) AND (pack_id = ANY ('{pack-1,pack-2}'::text[])))",
  "  Filter: ((component_key IS NOT NULL) AND (component_kind = ANY ('{skill,command,subagent,mcp}'::text[])))",
  `  ${ROWS_REMOVED_BY_FILTER_LABEL} 32`,
  "  Heap Blocks: exact=2",
  "  ->  Bitmap Index Scan on agent_components_org_pack_id_idx (actual rows=32 loops=1)",
  `        ${INDEX_COND_LABEL} ((organization_id = '14d8c474'::uuid) AND (pack_id = ANY ('{pack-1,pack-2}'::text[])))`,
].join("\n");

const MULTI_NODE_PLAN = [
  "Nested Loop",
  "  -> Index Scan using packs_pkey on packs",
  `        ${ROWS_REMOVED_BY_FILTER_LABEL} 7`,
  "  -> Index Scan using agent_components_org_pack_id_idx on agent_components",
  "        Index Cond: ((organization_id = $1) AND (pack_id = ANY ($2)))",
  `        ${ROWS_REMOVED_BY_FILTER_LABEL} 9000`,
].join("\n");

describe("requireNonEmptyPlan", () => {
  it("returns the plan text when EXPLAIN produced output", () => {
    expect(requireNonEmptyPlan(HEALTHY_PLAN, "case")).toBe(HEALTHY_PLAN);
  });

  it("throws on an empty plan instead of letting every assertion read vacuously", () => {
    expect(() => requireNonEmptyPlan("", "zero-match join")).toThrow(
      NO_PLAN_TEXT_RE
    );
  });

  it("throws on a whitespace-only plan", () => {
    expect(() => requireNonEmptyPlan("  \n \n", "zero-match join")).toThrow(
      NO_PLAN_TEXT_RE
    );
  });

  it("names the failing case so the error identifies which EXPLAIN was unavailable", () => {
    expect(() => requireNonEmptyPlan("", "zero-match join")).toThrow(
      CASE_NAME_RE
    );
  });
});

describe("requirePlanLine", () => {
  it("returns the first line carrying the label", () => {
    expect(requirePlanLine(HEALTHY_PLAN, INDEX_COND_LABEL)).toContain(
      "pack_id"
    );
  });

  it("throws when the expected plan node is absent instead of returning an empty string", () => {
    expect(() =>
      requirePlanLine(PLAN_WITHOUT_METRIC, INDEX_COND_LABEL)
    ).toThrow(INDEX_COND_ABSENT_RE);
  });

  it("embeds the plan in the failure so the chosen plan is readable from the error", () => {
    expect(() =>
      requirePlanLine(PLAN_WITHOUT_METRIC, INDEX_COND_LABEL)
    ).toThrow(SEQ_SCAN_RE);
  });

  it("refuses to read a node-scoped label off a multi-node plan", () => {
    // Reading "the first match in the text" bound the assertion to whichever
    // node sorted first, so a join could satisfy an upper bound from an
    // unrelated scan while the node under test walked the whole partition.
    expect(() =>
      requirePlanLine(MULTI_NODE_PLAN, ROWS_REMOVED_BY_FILTER_LABEL)
    ).toThrow(SPANNING_NODES_RE);
  });
});

describe("requireScanNode", () => {
  it("selects the target scan even when an unrelated node comes first", () => {
    // The exact shape the first-match read got wrong: the cheap node sorts
    // first and reports 7, the scan under test is second and reports 9000.
    const scan = requireScanNode(MULTI_NODE_PLAN, "agent_components");
    expect(scan).toContain("agent_components_org_pack_id_idx");
    expect(requireRowsRemovedByFilter(scan)).toBe(9000);
  });

  it("stops at the node's first child so a child's metric is not read as the node's", () => {
    const parentWithChild = [
      "Nested Loop",
      "  -> Index Scan using agent_components_org_pack_id_idx on agent_components",
      "        Index Cond: (organization_id = $1)",
      "    -> Seq Scan on packs",
      `          ${ROWS_REMOVED_BY_FILTER_LABEL} 9000`,
    ].join("\n");
    const scan = requireScanNode(parentWithChild, "agent_components");
    expect(scan).not.toContain("9000");
    expect(() => requireRowsRemovedByFilter(scan)).toThrow(
      ROWS_REMOVED_ABSENT_RE
    );
  });

  it("throws when no node scans the relation instead of falling back to the plan", () => {
    expect(() => requireScanNode(MULTI_NODE_PLAN, "sessions")).toThrow(
      NO_SCAN_NODE_RE
    );
  });

  it("selects each relation of a join independently", () => {
    // Proof the selector reads the relation rather than position: the same
    // plan yields 7 for one node and 9000 for the other.
    expect(
      requireRowsRemovedByFilter(requireScanNode(MULTI_NODE_PLAN, "packs"))
    ).toBe(7);
    expect(
      requireRowsRemovedByFilter(
        requireScanNode(MULTI_NODE_PLAN, "agent_components")
      )
    ).toBe(9000);
  });

  it("throws when more than one node scans the relation rather than picking one", () => {
    const ambiguous = [
      "Nested Loop",
      "  -> Seq Scan on agent_components",
      `        ${ROWS_REMOVED_BY_FILTER_LABEL} 7`,
      "  -> Index Scan using agent_components_org_pack_id_idx on agent_components",
      `        ${ROWS_REMOVED_BY_FILTER_LABEL} 9000`,
    ].join("\n");
    expect(() => requireScanNode(ambiguous, "agent_components")).toThrow(
      AMBIGUOUS_SCAN_NODE_RE
    );
  });

  it("does not match a relation whose name merely prefixes the scanned one", () => {
    const archive = [
      "Nested Loop",
      "  -> Seq Scan on agent_components_archive",
      `        ${ROWS_REMOVED_BY_FILTER_LABEL} 9000`,
    ].join("\n");
    expect(() => requireScanNode(archive, "agent_components")).toThrow(
      NO_SCAN_NODE_RE
    );
  });

  it("excludes the bitmap-index child from the node's own metric block", () => {
    // The heap node owns `Rows Removed by Filter`; the child owns `Index Cond`.
    const scan = requireScanNode(BITMAP_PLAN, "agent_components");
    expect(requireRowsRemovedByFilter(scan)).toBe(32);
    expect(scan).not.toContain(INDEX_COND_LABEL);
  });

  it("selects the root node when the plan is a single scan", () => {
    expect(requireScanNode(HEALTHY_PLAN, "agent_components")).toBe(
      HEALTHY_PLAN
    );
    expect(
      requireRowsRemovedByFilter(
        requireScanNode(HEALTHY_PLAN, "agent_components")
      )
    ).toBe(32);
  });
});

describe("requireRowsRemovedByFilter", () => {
  it("reads the metric from a healthy plan", () => {
    expect(requireRowsRemovedByFilter(HEALTHY_PLAN)).toBe(32);
  });

  it("reads the regressed plan's metric, which exceeds the guard's bound", () => {
    // The value the guard must reject. Proving it is READ (not defaulted) is
    // what makes `toBeLessThanOrEqual(32)` a real assertion.
    expect(requireRowsRemovedByFilter(REGRESSED_PLAN)).toBe(2388);
  });

  it("throws when the plan reports no Rows Removed by Filter rather than defaulting to 0", () => {
    // The ISS-6211 fail-open: `?? 0` made this plan satisfy `<= 32`.
    expect(() => requireRowsRemovedByFilter(PLAN_WITHOUT_METRIC)).toThrow(
      ROWS_REMOVED_ABSENT_RE
    );
  });

  it("throws on an empty plan rather than defaulting to 0", () => {
    expect(() => requireRowsRemovedByFilter("")).toThrow(
      ROWS_REMOVED_ABSENT_RE
    );
  });

  it("throws on a truncated metric value instead of coercing it", () => {
    const truncated = `Seq Scan on agent_components\n  ${ROWS_REMOVED_BY_FILTER_LABEL}`;
    expect(() => requireRowsRemovedByFilter(truncated)).toThrow(
      NOT_BARE_INTEGER_RE
    );
  });

  it("throws on trailing garbage that Number.parseInt would silently accept", () => {
    // `Number.parseInt("32 rows", 10)` is 32 — a reformatted or partially
    // written plan would have passed the bound on a value nobody verified.
    const garbled = `Seq Scan on agent_components\n  ${ROWS_REMOVED_BY_FILTER_LABEL} 32 rows`;
    expect(() => requireRowsRemovedByFilter(garbled)).toThrow(
      NOT_BARE_INTEGER_RE
    );
  });

  it("throws on a non-numeric metric value", () => {
    const garbled = `Seq Scan on agent_components\n  ${ROWS_REMOVED_BY_FILTER_LABEL} unknown`;
    expect(() => requireRowsRemovedByFilter(garbled)).toThrow(
      NOT_BARE_INTEGER_RE
    );
  });

  it("throws on a negative metric value", () => {
    const garbled = `Seq Scan on agent_components\n  ${ROWS_REMOVED_BY_FILTER_LABEL} -1`;
    expect(() => requireRowsRemovedByFilter(garbled)).toThrow(
      NOT_BARE_INTEGER_RE
    );
  });
});

describe("requireIndexPredicate", () => {
  it("reads Index Cond off the bitmap-index child of the relation's heap scan", () => {
    // The CI regression: this is a HEALTHY plan and the guard must accept it.
    const predicate = requireIndexPredicate(BITMAP_PLAN, "agent_components");
    expect(predicate).toContain("organization_id");
    expect(predicate).toContain("pack_id");
  });

  it("reads Index Cond off the scan node itself for a plain index scan", () => {
    expect(requireIndexPredicate(HEALTHY_PLAN, "agent_components")).toContain(
      "pack_id"
    );
  });

  it("does NOT borrow another relation's Index Cond when the target scan has none", () => {
    // The fallback that would have "fixed" CI by searching the whole plan:
    // the join's other relation must not satisfy the assertion.
    const seqScanTarget = [
      "Nested Loop",
      "  ->  Index Scan using packs_pkey on packs",
      `        ${INDEX_COND_LABEL} (id = $1)`,
      "  ->  Seq Scan on agent_components",
      `        ${ROWS_REMOVED_BY_FILTER_LABEL} 2388`,
    ].join("\n");
    expect(() =>
      requireIndexPredicate(seqScanTarget, "agent_components")
    ).toThrow(NO_INDEX_COND_RE);
  });

  it("throws when a BitmapAnd exposes several Index Cond lines rather than picking one", () => {
    const bitmapAnd = [
      "Bitmap Heap Scan on agent_components",
      "  Recheck Cond: (organization_id = $1)",
      "  ->  BitmapAnd",
      "        ->  Bitmap Index Scan on agent_components_organization_id_idx",
      `              ${INDEX_COND_LABEL} (organization_id = $1)`,
      "        ->  Bitmap Index Scan on agent_components_pack_id_idx",
      `              ${INDEX_COND_LABEL} (pack_id = ANY ($2))`,
    ].join("\n");
    expect(() => requireIndexPredicate(bitmapAnd, "agent_components")).toThrow(
      AMBIGUOUS_INDEX_COND_RE
    );
  });

  it("stops at the bitmap scan's sibling so a later node cannot supply the predicate", () => {
    const withSibling = [
      "Nested Loop",
      "  ->  Bitmap Heap Scan on agent_components",
      "        Recheck Cond: (organization_id = $1)",
      "  ->  Index Scan using packs_pkey on packs",
      `        ${INDEX_COND_LABEL} (id = $1)`,
    ].join("\n");
    expect(() =>
      requireIndexPredicate(withSibling, "agent_components")
    ).toThrow(NO_INDEX_COND_RE);
  });

  it("throws when no node scans the relation at all", () => {
    expect(() => requireIndexPredicate(BITMAP_PLAN, "sessions")).toThrow(
      NO_SCAN_NODE_RE
    );
  });
});
