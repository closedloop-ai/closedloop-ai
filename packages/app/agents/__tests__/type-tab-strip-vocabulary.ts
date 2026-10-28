/**
 * The Agents catalog type-tab strip's vocabulary, written out by hand.
 *
 * DO NOT DERIVE THIS FROM `KIND_ORDER`, `SCOPED_OUT_KINDS`, `SCOPED_CORE_KINDS`,
 * OR `kindMeta` — the duplication IS the test. `agents-grouped-list.permalink
 * .test.tsx` renders the production strip and asserts it equals this list;
 * rebuilding it from the constants production filters would make that guard
 * assert a value equals itself, which is the defect this module closes
 * (ISS-6271), not a cleanup to undo.
 *
 * When the vocabulary legitimately changes the guard goes red: edit this list
 * deliberately, and the fit and overflow suites move with it.
 *
 * A hand-written value can still go stale — pinning a kind the enum retired.
 * That is covered by the sibling `type-tab-strip-vocabulary.test.ts`, which
 * checks membership WITHOUT supplying the expectation, so the pin keeps its
 * ability to fail.
 */

/** One segment of the strip: the `?kind=` permalink value, and its label. */
export type TypeTabSegment = {
  value: string;
  label: string;
};

/**
 * All eight segments in render order: `All`, then one per core kind.
 *
 * `Workflow`, `Config`, and `Orchestration` are deliberately absent. They are
 * live kinds that still collect, render under `All`, and badge — FEA-4019
 * graduated only Tools/MCPs/Hooks to tabs and left the non-promotable
 * orchestration primitives scoped out. Their absence is the product behavior.
 */
export const EXPECTED_TYPE_TAB_SEGMENTS: readonly TypeTabSegment[] = [
  { value: "all", label: "All" },
  { value: "subagent", label: "Agents" },
  { value: "command", label: "Commands" },
  { value: "skill", label: "Skills" },
  { value: "plugin", label: "Plugins" },
  { value: "mcp", label: "MCPs" },
  { value: "tool", label: "Tools" },
  { value: "hook", label: "Hooks" },
];

/** The same vocabulary as bare labels, for the width/fit arithmetic. */
export const EXPECTED_TYPE_TAB_LABELS: readonly string[] =
  EXPECTED_TYPE_TAB_SEGMENTS.map((segment) => segment.label);
