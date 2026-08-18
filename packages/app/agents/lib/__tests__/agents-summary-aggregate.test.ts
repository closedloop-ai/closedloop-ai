/**
 * ISS-5534 — the Agents list Invocations summary card must count each
 * invocation ONCE.
 *
 * A `plugin` component is never invoked directly: both the cloud rollup
 * (`apps/api/app/agent-components/plugin-child-usage.ts`) and the desktop reader
 * REPLACE a plugin row's `invocations` with the SUM of its
 * skill/command/subagent/mcp children's usage. On the "All" type tab the plugin
 * AND those children are rows in the SAME population, so a flat sum adds every
 * child invocation twice — the aggregation-double-count case this repo requires
 * coverage for whenever the same entity can reach an aggregate through more than
 * one input stream.
 *
 * These tests therefore always seed a plugin AND its children with NON-ZERO
 * invocations: a fixture with a childless plugin, or with zero-invocation
 * children, passes identically on the broken and the fixed reduction and proves
 * nothing.
 */

import {
  type AgentComponent,
  AgentComponentKind,
} from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import { makeComponent } from "../../components/workspace/agent-component-fixtures";
import {
  computeSummaryAggregate,
  computeSummaryAggregatePair,
  invocationsDerivation,
  sumDedupedInvocations,
} from "../agents-summary-aggregate";

/**
 * The pack the plugin below IS, and the pack its two children belong to — the
 * `AgentComponent.packIds` parent identity both producers emit (ISS-5534, wongk
 * review). Every fixture here carries it, because a fixture WITHOUT it exercises
 * the version-skew fallback rather than the current contract; that path has its
 * own named cases at the end of the `sumDedupedInvocations` block.
 */
const REVIEW_PACK_ID = "pr-review-toolkit";

/** A plugin whose 500 invocations are the rollup of the two children below. */
const PLUGIN_ROW = makeComponent({
  id: "uuid-plugin-1",
  slug: "plugin::pr-review-toolkit",
  name: "pr-review-toolkit",
  kind: AgentComponentKind.Plugin,
  invocations: 500,
  sessions: 40,
  packIds: [REVIEW_PACK_ID],
});

const CHILD_SKILL_ROW = makeComponent({
  id: "uuid-skill-cr",
  slug: "skill::code-review",
  name: "code-review",
  kind: AgentComponentKind.Skill,
  invocations: 300,
  sessions: 25,
  packIds: [REVIEW_PACK_ID],
});

const CHILD_COMMAND_ROW = makeComponent({
  id: "uuid-cmd-cr",
  slug: "command::commit",
  name: "commit",
  kind: AgentComponentKind.Command,
  invocations: 200,
  sessions: 15,
  packIds: [REVIEW_PACK_ID],
});

/**
 * A subagent belonging to NO pack. It is a plugin-CHILD kind, which is exactly
 * what makes it the counter-example to a population-wide "are there any child
 * rows?" test: it can never be part of any plugin's rollup, so its presence must
 * not cause a plugin's rollup to be dropped.
 */
const STANDALONE_SUBAGENT_ROW = makeComponent({
  id: "uuid-sub-standalone",
  slug: "subagent::orchestrator",
  name: "orchestrator",
  kind: AgentComponentKind.Subagent,
  invocations: 70,
  sessions: 6,
});

/** The All-tab population: the plugin plus the children it rolled up FROM. */
const ALL_TAB_ROWS: readonly AgentComponent[] = [
  PLUGIN_ROW,
  CHILD_SKILL_ROW,
  CHILD_COMMAND_ROW,
];

/** The Plugins-tab population: rollups only, no leaves to count instead. */
const PLUGINS_TAB_ROWS: readonly AgentComponent[] = [PLUGIN_ROW];

describe("sumDedupedInvocations", () => {
  it("counts a plugin's invocations once when its child rows are in the same population", () => {
    // The flat sum is 500 + 300 + 200 = 1000, but only 500 invocations really
    // happened: the plugin row IS the 300 + 200.
    expect(sumDedupedInvocations(ALL_TAB_ROWS)).toBe(500);
  });

  it("still counts plugin rollups when no child-kind row represents them", () => {
    // Plugins tab: dropping the rollup here would report a flat 0 for a plugin
    // with real activity, which is a worse lie than the double-count.
    expect(sumDedupedInvocations(PLUGINS_TAB_ROWS)).toBe(500);
  });

  it("never drops a non-plugin row's invocations", () => {
    expect(
      sumDedupedInvocations([...ALL_TAB_ROWS, STANDALONE_SUBAGENT_ROW])
    ).toBe(570);
  });

  // wongk review on #4902, verbatim: "A filter can keep a 500-invocation plugin,
  // exclude its actual children, and retain an unrelated 70-invocation subagent;
  // this renders 70 instead of 570."
  //
  // This is the case the pre-review reduction got WRONG, not merely imprecise.
  // It computed ONE population-wide `hasChildRows` boolean and dropped EVERY
  // plugin when it was true, so the unrelated subagent — a plugin-child KIND
  // that belongs to no pack — zeroed a plugin whose own children are nowhere in
  // view. Against that logic this asserts 570 where it produced 70.
  it("keeps a plugin's rollup when an UNRELATED child-kind row is the only child present", () => {
    expect(sumDedupedInvocations([PLUGIN_ROW, STANDALONE_SUBAGENT_ROW])).toBe(
      570
    );
  });

  // The same shape one step further out: a child-kind row that belongs to a
  // DIFFERENT pack is no more this plugin's child than a pack-less one is.
  it("keeps a plugin's rollup when the only child rows belong to another pack", () => {
    const otherPackSkill = makeComponent({
      id: "uuid-skill-other",
      slug: "skill::docs",
      kind: AgentComponentKind.Skill,
      invocations: 70,
      packIds: ["docs-toolkit"],
    });
    expect(sumDedupedInvocations([PLUGIN_ROW, otherPackSkill])).toBe(570);
  });

  it("drops only the plugin whose own children are present, not every plugin", () => {
    const otherPlugin = makeComponent({
      id: "uuid-plugin-2",
      slug: "plugin::docs-toolkit",
      kind: AgentComponentKind.Plugin,
      invocations: 90,
      packIds: ["docs-toolkit"],
    });
    // 300 + 200 (the represented children) + 90 (the plugin whose children are
    // NOT in view) — and 0 from the plugin those children belong to.
    expect(sumDedupedInvocations([...ALL_TAB_ROWS, otherPlugin])).toBe(590);
  });

  // Cross-repo skew: a producer that predates `packIds` omits it EVERYWHERE,
  // including on the plugin row. With no parentage on the wire this reader
  // cannot be precise, so it falls back to the population-wide test — which can
  // only UNDER-count, never inflate the very number this card exists to fix.
  it("falls back to the population-wide test when the producer emits no packIds", () => {
    const legacyPlugin = makeComponent({
      id: "uuid-plugin-legacy",
      slug: "plugin::legacy",
      kind: AgentComponentKind.Plugin,
      invocations: 500,
    });
    const legacyChild = makeComponent({
      id: "uuid-skill-legacy",
      slug: "skill::legacy-child",
      kind: AgentComponentKind.Skill,
      invocations: 300,
    });
    expect(sumDedupedInvocations([legacyPlugin, legacyChild])).toBe(300);
    // …and with no child-kind row at all the legacy rollup is still counted,
    // exactly as it is under the current contract.
    expect(sumDedupedInvocations([legacyPlugin])).toBe(500);
  });

  it("treats a null invocation count as zero rather than NaN", () => {
    const unmeasured = makeComponent({
      id: "uuid-hook-1",
      slug: "hook::pre-commit",
      kind: AgentComponentKind.Hook,
      invocations: null,
    });
    expect(sumDedupedInvocations([CHILD_SKILL_ROW, unmeasured])).toBe(300);
  });
});

describe("computeSummaryAggregate", () => {
  it("keeps the pre-ISS-5534 flat sum when the dedupe gate is off (default)", () => {
    // Closed-by-default: with the flag off the card must render EXACTLY the
    // inflated prior total, so no user sees a change until the flag is lit.
    expect(computeSummaryAggregate(ALL_TAB_ROWS).invocations).toBe(1000);
    expect(computeSummaryAggregate(ALL_TAB_ROWS, false).invocations).toBe(1000);
  });

  it("de-duplicates the plugin rollup when the gate is on", () => {
    expect(computeSummaryAggregate(ALL_TAB_ROWS, true).invocations).toBe(500);
  });

  it("leaves every other aggregate untouched by the gate", () => {
    const off = computeSummaryAggregate(ALL_TAB_ROWS, false);
    const on = computeSummaryAggregate(ALL_TAB_ROWS, true);
    expect(on.components).toBe(off.components);
    expect(on.avgLocPerDollar).toBe(off.avgLocPerDollar);
    expect(on.locPerDollarSampleSize).toBe(off.locPerDollarSampleSize);
    expect(on.collaborators).toBe(off.collaborators);
    expect(on.hasVerifiableLocPerDollar).toBe(off.hasVerifiableLocPerDollar);
  });

  it("counts distinct collaborators across the population", () => {
    const rows = [
      makeComponent({ id: "a", collaborators: ["ann", "bo"] }),
      makeComponent({ id: "b", collaborators: ["bo"] }),
    ];
    expect(computeSummaryAggregate(rows).collaborators).toBe(2);
  });

  it("reports LOC/$ as null with a zero sample when no row carries a ratio", () => {
    const rows = [makeComponent({ id: "a", locPerDollar: null })];
    const aggregate = computeSummaryAggregate(rows);
    expect(aggregate.avgLocPerDollar).toBeNull();
    expect(aggregate.locPerDollarSampleSize).toBe(0);
  });

  it("hides the LOC/$ card for a population with no verifiable kind", () => {
    expect(
      computeSummaryAggregate(PLUGINS_TAB_ROWS).hasVerifiableLocPerDollar
    ).toBe(false);
    expect(
      computeSummaryAggregate([STANDALONE_SUBAGENT_ROW])
        .hasVerifiableLocPerDollar
    ).toBe(true);
  });

  it("treats a null-invocation plugin rollup as zero on a childless population", () => {
    // The Plugins-tab branch (`hasChildRows === false`) still reads
    // `invocations`, so an unmeasured plugin must contribute 0, not NaN.
    const unmeasuredPlugin = makeComponent({
      id: "uuid-plugin-null",
      slug: "plugin::never-run",
      kind: AgentComponentKind.Plugin,
      invocations: null,
      packIds: ["never-run"],
    });
    expect(
      computeSummaryAggregate([PLUGIN_ROW, unmeasuredPlugin], true).invocations
    ).toBe(500);
  });
});

/**
 * The PRECEDING window carries the same plugin-and-children shape as the current
 * one, at a different magnitude: a flat sum of 200, a de-duplicated sum of 100.
 * The two totals are deliberately distinct from the current window's 1000/500 so
 * an assertion cannot pass by reading the wrong population.
 */
const PREVIOUS_WINDOW_ROWS: readonly AgentComponent[] = [
  makeComponent({
    id: "uuid-plugin-1-prev",
    slug: "plugin::pr-review-toolkit",
    kind: AgentComponentKind.Plugin,
    invocations: 100,
    packIds: [REVIEW_PACK_ID],
  }),
  makeComponent({
    id: "uuid-skill-cr-prev",
    slug: "skill::code-review",
    kind: AgentComponentKind.Skill,
    invocations: 60,
    packIds: [REVIEW_PACK_ID],
  }),
  makeComponent({
    id: "uuid-cmd-cr-prev",
    slug: "command::commit",
    kind: AgentComponentKind.Command,
    invocations: 40,
    packIds: [REVIEW_PACK_ID],
  }),
];

describe("computeSummaryAggregatePair", () => {
  // ISS-5534 / FEA-3178: the delta chip divides the current aggregate by the
  // preceding one, so the two windows MUST be reduced under the same rule. If
  // the de-duplication reached only the current window, the card would compare a
  // deduped 500 against a flat 200 and report the de-duplication itself as a
  // +150% usage jump — a fabricated delta, from a fix meant to stop a lie.
  it("applies the dedupe gate to the PRECEDING window as well as the current", () => {
    const { current, previous } = computeSummaryAggregatePair(
      ALL_TAB_ROWS,
      PREVIOUS_WINDOW_ROWS,
      true
    );
    expect(current.invocations).toBe(500);
    // 100, not the flat 200: had the gate been threaded to `current` only, this
    // is the assertion that fails.
    expect(previous?.invocations).toBe(100);
  });

  it("leaves BOTH windows flat when the dedupe gate is off", () => {
    const { current, previous } = computeSummaryAggregatePair(
      ALL_TAB_ROWS,
      PREVIOUS_WINDOW_ROWS,
      false
    );
    expect(current.invocations).toBe(1000);
    expect(previous?.invocations).toBe(200);
  });

  it("reports no preceding aggregate when there is no preceding population", () => {
    const { current, previous } = computeSummaryAggregatePair(
      ALL_TAB_ROWS,
      undefined,
      true
    );
    expect(current.invocations).toBe(500);
    expect(previous).toBeUndefined();
  });
});

/**
 * ISS-6182 — the card's stated method and the number beside it must come out of
 * the SAME gate. The card previously carried its own explainer literal, so with
 * the ISS-5534 flag on it promised a plain per-component sum next to a total
 * that deliberately drops every represented plugin rollup.
 */
describe("invocationsDerivation", () => {
  // wongk review on #5038: the first spelling of this copy said the excluded
  // rollups were "already represented by component rows in view", which neither
  // branch of `rollupIsAlreadyRepresented` verifies — see the case below. The
  // negative assertion is the guard against that sentence coming back.
  it("pairs the deduped reduction with an explainer that names the real trigger", () => {
    const derivation = invocationsDerivation(true);

    expect(derivation.reduce(ALL_TAB_ROWS)).toBe(500);
    expect(derivation.how).toContain(
      "any component that could belong to it is in view"
    );
    expect(derivation.how).toContain("undercounts");
    expect(derivation.how).not.toContain("already represented");
  });

  // The number the sentence above promises. One in-view child of the pack drops
  // the plugin's WHOLE 500 — the 200 on the filtered-out command row included —
  // so the card reports 300, an under-count and not a double-count. A reduction
  // that instead subtracted only the represented 300 would render 500 here and
  // make that sentence wrong again.
  it("drops a plugin's whole rollup when only ONE of its children is in view", () => {
    expect(sumDedupedInvocations([PLUGIN_ROW, CHILD_SKILL_ROW])).toBe(300);
  });

  it("pairs the flat reduction with an explainer that claims no exclusion", () => {
    const derivation = invocationsDerivation(false);

    expect(derivation.reduce(ALL_TAB_ROWS)).toBe(1000);
    expect(derivation.how).not.toContain("exclud");
  });

  // The explainer is only trustworthy while this is the same reduction the card
  // displayed. A second selection of the reduction anywhere else — the inline
  // ternary this replaced — fails here as soon as the two disagree.
  it("describes the reduction computeSummaryAggregate actually ran", () => {
    expect(invocationsDerivation(true).reduce(ALL_TAB_ROWS)).toBe(
      computeSummaryAggregate(ALL_TAB_ROWS, true).invocations
    );
    expect(invocationsDerivation(false).reduce(ALL_TAB_ROWS)).toBe(
      computeSummaryAggregate(ALL_TAB_ROWS, false).invocations
    );
  });
});
