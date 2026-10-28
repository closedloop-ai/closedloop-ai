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
import {
  computeSummaryAggregate,
  computeSummaryAggregatePair,
  invocationsDerivation,
  isInvocationsComparable,
  type SummaryAggregate,
  sumDedupedInvocations,
} from "@repo/api/src/utils/agent-component-summary-aggregate";
import { describe, expect, it } from "vitest";
import { makeComponent } from "../../components/workspace/agent-component-fixtures";

/**
 * The pack the plugin below IS, and the pack its two children belong to — the
 * `AgentComponent.packIds` parent identity both producers emit (ISS-5534, whitlockk
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

/**
 * ISS-6205: a version-skewed producer's population — a plugin with NO `packIds`
 * beside a child-kind row it may or may not own. This is the only shape whose
 * de-duplicated total is inexact, so it is the fixture that can tell the two
 * gates apart.
 */
const LEGACY_SKEW_ROWS: readonly AgentComponent[] = [
  makeComponent({
    id: "uuid-plugin-skew",
    slug: "plugin::skew",
    kind: AgentComponentKind.Plugin,
    invocations: 500,
  }),
  makeComponent({
    id: "uuid-skill-skew",
    slug: "skill::skew-child",
    kind: AgentComponentKind.Skill,
    invocations: 300,
  }),
];

/**
 * ISS-6205: `sumDedupedInvocations` reports a total AND whether that total is
 * exact. The cases below that only care about the arithmetic read it through
 * this helper; the ones that are about exactness assert on the pair directly.
 */
const dedupedTotal = (rows: readonly AgentComponent[]): number =>
  sumDedupedInvocations(rows).invocations;

describe("sumDedupedInvocations", () => {
  it("counts a plugin's invocations once when its child rows are in the same population", () => {
    // The flat sum is 500 + 300 + 200 = 1000, but only 500 invocations really
    // happened: the plugin row IS the 300 + 200.
    expect(dedupedTotal(ALL_TAB_ROWS)).toBe(500);
  });

  it("still counts plugin rollups when no child-kind row represents them", () => {
    // Plugins tab: dropping the rollup here would report a flat 0 for a plugin
    // with real activity, which is a worse lie than the double-count.
    expect(dedupedTotal(PLUGINS_TAB_ROWS)).toBe(500);
  });

  it("never drops a non-plugin row's invocations", () => {
    expect(dedupedTotal([...ALL_TAB_ROWS, STANDALONE_SUBAGENT_ROW])).toBe(570);
  });

  // whitlockk review on #4902, verbatim: "A filter can keep a 500-invocation plugin,
  // exclude its actual children, and retain an unrelated 70-invocation subagent;
  // this renders 70 instead of 570."
  //
  // This is the case the pre-review reduction got WRONG, not merely imprecise.
  // It computed ONE population-wide `hasChildRows` boolean and dropped EVERY
  // plugin when it was true, so the unrelated subagent — a plugin-child KIND
  // that belongs to no pack — zeroed a plugin whose own children are nowhere in
  // view. Against that logic this asserts 570 where it produced 70.
  it("keeps a plugin's rollup when an UNRELATED child-kind row is the only child present", () => {
    expect(dedupedTotal([PLUGIN_ROW, STANDALONE_SUBAGENT_ROW])).toBe(570);
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
    expect(dedupedTotal([PLUGIN_ROW, otherPackSkill])).toBe(570);
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
    expect(dedupedTotal([...ALL_TAB_ROWS, otherPlugin])).toBe(590);
  });

  // Cross-repo skew: a producer that predates `packIds` omits it EVERYWHERE,
  // including on the plugin row, so this reader cannot know that plugin's
  // parentage at all.
  //
  // ISS-6205 (codex review): the canonical `AgentComponent.packIds` contract
  // fixes the DIRECTION of this fallback — absence on a plugin row means the
  // reader "must degrade to a population-wide heuristic (which may under-count)
  // rather than to an over-count". So the 500 is dropped, not counted: a
  // version-skewed producer must never be able to push this card above the
  // truth. What ISS-6205 changes is the SILENCE — the same drop now publishes
  // `exact: false`, so the card stops rendering 300 as a measured total.
  it("drops a legacy plugin's rollup but reports the total inexact", () => {
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

    const result = sumDedupedInvocations([legacyPlugin, legacyChild]);

    expect(result.invocations).toBe(300);
    expect(result.exact).toBe(false);
  });

  // ISS-6205, second half: unknown parentage is a reason to DOUBT a total, never
  // on its own a reason to disclaim one. Double-counting a legacy rollup needs a
  // child-kind row to double-count it against; with none in the population there
  // is nothing it could collide with, so 500 is measured, not estimated.
  //
  // This is the Plugins type tab's exact shape (ISS-5533) — that view carries
  // plugin rows and nothing else. Reporting it inexact would stamp a permanent
  // `~` on every legacy deployment's Plugins tab over a provably correct number,
  // trading the old silent undercount for a standing false disclaimer.
  it("reports an exact total for a legacy rollup with no child-kind row at all", () => {
    const legacyPlugin = makeComponent({
      id: "uuid-plugin-legacy",
      slug: "plugin::legacy",
      kind: AgentComponentKind.Plugin,
      invocations: 500,
    });

    const result = sumDedupedInvocations([legacyPlugin]);

    expect(result.invocations).toBe(500);
    expect(result.exact).toBe(true);
  });

  // The child row that makes the SAME legacy plugin inexact is a plugin-child
  // kind specifically. A second plugin row is not something the first plugin's
  // rollup can be double-counted against, so a Plugins tab full of legacy
  // plugins stays exact no matter how many rows it holds.
  it("stays exact for a whole population of legacy plugin rows", () => {
    const legacyPlugins = [500, 300, 200].map((invocations, index) =>
      makeComponent({
        id: `uuid-plugin-legacy-${index}`,
        slug: `plugin::legacy-${index}`,
        kind: AgentComponentKind.Plugin,
        invocations,
      })
    );

    const result = sumDedupedInvocations(legacyPlugins);

    expect(result.invocations).toBe(1000);
    expect(result.exact).toBe(true);
  });

  // ISS-6205 code review: a rollup can only have double-counted what it
  // CONTRIBUTED. A windowed query returns 0/null invocations for a plugin whose
  // children had no in-window usage, and an unknown-parentage plugin adding
  // nothing has provably overlapped nothing — so it must not cost the total its
  // exactness. Getting this wrong puts a standing caveat on a measured number
  // and silently withholds the delta chip, which is the same lie inverted.
  it("stays exact when the unknown-parentage plugin contributed nothing", () => {
    const emptyLegacyPlugin = makeComponent({
      id: "uuid-plugin-legacy-empty",
      slug: "plugin::legacy-empty",
      kind: AgentComponentKind.Plugin,
      invocations: null,
    });

    const result = sumDedupedInvocations([emptyLegacyPlugin, CHILD_SKILL_ROW]);

    expect(result.invocations).toBe(300);
    expect(result.exact).toBe(true);
  });

  // ISS-6205 code review (whitlockk), the MIRROR of the case above. The fallback
  // needs something the rollup could actually be restating, and a windowed query
  // returns rows for the components that HAD usage — so children sitting at zero
  // contributed nothing. Probing "are there any child rows" instead of "did any
  // child contribute" drops a 500-invocation legacy plugin against zero overlap
  // and puts a standing caveat on the remainder: an undercount to 0, disclaimed.
  it("counts a legacy plugin exactly when every child row contributed zero", () => {
    const legacyPlugin = makeComponent({
      id: "uuid-plugin-legacy",
      slug: "plugin::legacy",
      kind: AgentComponentKind.Plugin,
      invocations: 500,
    });
    const idleChild = makeComponent({
      id: "uuid-skill-idle",
      slug: "skill::idle",
      kind: AgentComponentKind.Skill,
      invocations: 0,
    });

    const result = sumDedupedInvocations([legacyPlugin, idleChild]);

    expect(result.invocations).toBe(500);
    expect(result.exact).toBe(true);
  });

  it("reports an exact total when every plugin carries packIds", () => {
    const result = sumDedupedInvocations(ALL_TAB_ROWS);

    expect(result.invocations).toBe(500);
    expect(result.exact).toBe(true);
  });

  // The exactness flag must track the PARENTAGE question, not merely "was a
  // plugin counted". A plugin whose packIds are present but match nothing in
  // view is counted for a KNOWN reason — its children are genuinely absent — so
  // the total it contributes to is exact.
  it("stays exact when a packIds-carrying plugin is counted because no child matched", () => {
    const otherPackSkill = makeComponent({
      id: "uuid-skill-other",
      slug: "skill::other-pack",
      kind: AgentComponentKind.Skill,
      invocations: 70,
      packIds: ["pack-other"],
    });

    const result = sumDedupedInvocations([PLUGIN_ROW, otherPackSkill]);

    expect(result.invocations).toBe(570);
    expect(result.exact).toBe(true);
  });

  it("treats a null invocation count as zero rather than NaN", () => {
    const unmeasured = makeComponent({
      id: "uuid-hook-1",
      slug: "hook::pre-commit",
      kind: AgentComponentKind.Hook,
      invocations: null,
    });
    expect(dedupedTotal([CHILD_SKILL_ROW, unmeasured])).toBe(300);
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
    expect(on.locPerDollar).toBe(off.locPerDollar);
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
    expect(aggregate.locPerDollar).toBeNull();
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
    // The childless branch (no contributing child row, so every plugin is
    // `Independent`) still reads `invocations`, so an unmeasured plugin must
    // contribute 0, not NaN.
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

  // ISS-6205: exactness is a property of each window's OWN data — a legacy
  // plugin can be in one window and not the other — so the pair can legitimately
  // disagree. The card suppresses its delta chip on exactly this shape, because
  // dividing an approximated current by a measured baseline reports the change
  // in COUNTING METHOD as a change in usage. That is the same fabricated-delta
  // failure FEA-3178 and the two cases above exist to prevent, so the pair has
  // to be able to express the disagreement rather than flatten it.
  it("lets the two windows disagree on exactness when only one holds a legacy plugin", () => {
    const { current, previous } = computeSummaryAggregatePair(
      LEGACY_SKEW_ROWS,
      ALL_TAB_ROWS,
      true
    );

    expect(current.invocationsExact).toBe(false);
    expect(previous?.invocationsExact).toBe(true);
  });

  it("keeps both windows exact when neither holds a legacy plugin", () => {
    const { current, previous } = computeSummaryAggregatePair(
      ALL_TAB_ROWS,
      PREVIOUS_WINDOW_ROWS,
      true
    );

    expect(current.invocationsExact).toBe(true);
    expect(previous?.invocationsExact).toBe(true);
  });
});

/**
 * The preceding window in whitlockk's review case: the SAME plugin, at the SAME pack
 * identity, with no child row beside it because that child had zero prior usage
 * and a windowed query returns rows for what actually ran. Nothing here is
 * skewed or approximate — both windows reduce exactly — which is the whole point:
 * exactness cannot detect this.
 */
const PREVIOUS_WINDOW_PLUGIN_ONLY: readonly AgentComponent[] = [
  makeComponent({
    id: "uuid-plugin-1-prev",
    slug: "plugin::pr-review-toolkit",
    kind: AgentComponentKind.Plugin,
    invocations: 100,
    packIds: [REVIEW_PACK_ID],
  }),
];

describe("isInvocationsComparable", () => {
  // ISS-6205 code review (whitlockk). Current holds the plugin AND a child of its
  // pack, so the rollup is dropped as represented; preceding holds only the
  // plugin, so the rollup is the sole record and is counted. Both windows are
  // exact and both are right — but 500 and 100 were reduced by DIFFERENT rules,
  // so a percentage between them reports the change in counting method as a
  // change in usage. Comparing exactness alone (the shape this replaced) returns
  // true here and the card emits that percentage.
  it("withholds the comparison when the same plugin was dropped in one window and counted in the other", () => {
    const { current, previous } = computeSummaryAggregatePair(
      ALL_TAB_ROWS,
      PREVIOUS_WINDOW_PLUGIN_ONLY,
      true
    );

    expect(current.invocationsExact).toBe(true);
    expect(previous?.invocationsExact).toBe(true);
    expect(isInvocationsComparable(current, previous)).toBe(false);
  });

  it("compares two windows that treated every shared plugin the same way", () => {
    const { current, previous } = computeSummaryAggregatePair(
      ALL_TAB_ROWS,
      PREVIOUS_WINDOW_ROWS,
      true
    );

    expect(isInvocationsComparable(current, previous)).toBe(true);
  });

  // A plugin in only ONE window is a real population change — components appear
  // and disappear between windows — and that is precisely what the delta exists
  // to report. Only a plugin present in BOTH under different rules is a false
  // comparison, so provenance is matched per slug rather than set-equality.
  it("does not treat a plugin present in only one window as a mismatch", () => {
    const { current, previous } = computeSummaryAggregatePair(
      [...ALL_TAB_ROWS, STANDALONE_SUBAGENT_ROW],
      [CHILD_SKILL_ROW, CHILD_COMMAND_ROW],
      true
    );

    expect(isInvocationsComparable(current, previous)).toBe(true);
  });

  it("withholds the comparison when either window is inexact", () => {
    const { current, previous } = computeSummaryAggregatePair(
      LEGACY_SKEW_ROWS,
      ALL_TAB_ROWS,
      true
    );

    expect(isInvocationsComparable(current, previous)).toBe(false);
    expect(isInvocationsComparable(previous as SummaryAggregate, current)).toBe(
      false
    );
  });

  // No preceding population means no comparison was asked for, so there is
  // nothing to withhold — the card decides separately whether to render a
  // placeholder, and claiming a comparison was suppressed would be its own lie.
  it("reports comparable when there is no preceding window at all", () => {
    const { current, previous } = computeSummaryAggregatePair(
      ALL_TAB_ROWS,
      undefined,
      true
    );

    expect(isInvocationsComparable(current, previous)).toBe(true);
  });

  // The flag-off flat sum makes no per-plugin decision at all, so a dark-launched
  // surface can never lose its delta chip to this check.
  it("always compares when the dedupe gate is off", () => {
    const { current, previous } = computeSummaryAggregatePair(
      ALL_TAB_ROWS,
      PREVIOUS_WINDOW_PLUGIN_ONLY,
      false
    );

    expect(isInvocationsComparable(current, previous)).toBe(true);
  });
});

/**
 * ISS-6182 — the card's stated method and the number beside it must come out of
 * the SAME gate. The card previously carried its own explainer literal, so with
 * the ISS-5534 flag on it promised a plain per-component sum next to a total
 * that deliberately drops every represented plugin rollup.
 */
describe("invocationsDerivation", () => {
  // whitlockk review on #5038: the first spelling of this copy said the excluded
  // rollups were "already represented by component rows in view", which neither
  // branch of `rollupIsAlreadyRepresented` verifies — see the case below. The
  // negative assertion is the guard against that sentence coming back.
  it("pairs the deduped reduction with an explainer that names the real trigger", () => {
    const derivation = invocationsDerivation(true);

    expect(derivation.reduce(ALL_TAB_ROWS).invocations).toBe(500);
    expect(derivation.explain(true).how).toContain(
      "any component that could belong to it is in view"
    );
    expect(derivation.explain(true).how).toContain("undercounts");
    expect(derivation.explain(true).how).not.toContain("already represented");
  });

  // ISS-6205: the de-duplicated path now has TWO honest sentences, and the EXACT
  // one is wrong for the inexact number. Both branches drop the rollup, but the
  // exact sentence explains WHY the calls are safe to drop — the components that
  // could belong to the plugin are right there in view — which is exactly what
  // the unknown-parentage branch cannot claim. Handing the same string to both
  // would put the card back to describing a derivation it did not run — the
  // ISS-6182 defect, reopened by ISS-6205.
  it("gives the inexact deduped total its own explainer, naming the missing calls", () => {
    const derivation = invocationsDerivation(true);
    const inexact = derivation.explain(false);

    expect(inexact.how).toContain(
      "does not report which components belong to it"
    );
    expect(inexact.how).toContain("missing");
    expect(inexact.how).not.toContain("counted twice");
    expect(inexact.how).not.toBe(derivation.explain(true).how);
    // The caveat also reaches the card's CAPTION, which — unlike a glyph — is
    // read out by a screen reader (ISS-6205 design review, ISS-5761).
    expect(inexact.detail).toContain("missing");
    expect(inexact.detail).not.toBe(derivation.explain(true).detail);
  });

  // The number the sentence above promises. One in-view child of the pack drops
  // the plugin's WHOLE 500 — the 200 on the filtered-out command row included —
  // so the card reports 300, an under-count and not a double-count. A reduction
  // that instead subtracted only the represented 300 would render 500 here and
  // make that sentence wrong again.
  it("drops a plugin's whole rollup when only ONE of its children is in view", () => {
    expect(dedupedTotal([PLUGIN_ROW, CHILD_SKILL_ROW])).toBe(300);
  });

  it("pairs the flat reduction with an explainer that claims no exclusion", () => {
    const derivation = invocationsDerivation(false);

    expect(derivation.reduce(ALL_TAB_ROWS).invocations).toBe(1000);
    expect(derivation.explain(true).how).not.toContain("exclud");
  });

  // The flat sum de-duplicates nothing, so it has no parentage to be unsure
  // about and must never reach the approximate branch. Pinning `exact` here is
  // what keeps the closed-by-default path from ever rendering a `~`.
  it("always reports the flat reduction exact, so the gated-off card never approximates", () => {
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

    // The exact population that makes the DEDUPED reduction inexact.
    expect(sumDedupedInvocations([legacyPlugin, legacyChild]).exact).toBe(
      false
    );
    expect(
      invocationsDerivation(false).reduce([legacyPlugin, legacyChild]).exact
    ).toBe(true);
    expect(
      computeSummaryAggregate([legacyPlugin, legacyChild], false)
        .invocationsExact
    ).toBe(true);
  });

  // The explainer is only trustworthy while this is the same reduction the card
  // displayed. A second selection of the reduction anywhere else — the inline
  // ternary this replaced — fails here as soon as the two disagree. ISS-6205
  // adds `exact` to what must survive that hand-off: a `computeSummaryAggregate`
  // that recomputed exactness on its own could disagree with the reduction whose
  // sentence the card is about to render.
  it("describes the reduction computeSummaryAggregate actually ran", () => {
    for (const dedupe of [true, false]) {
      const reduced = invocationsDerivation(dedupe).reduce(LEGACY_SKEW_ROWS);
      const aggregate = computeSummaryAggregate(LEGACY_SKEW_ROWS, dedupe);

      expect(reduced.invocations).toBe(aggregate.invocations);
      expect(reduced.exact).toBe(aggregate.invocationsExact);
    }
    // …and the fixture really does separate the two gates, so the loop above
    // cannot pass by both sides being identical.
    expect(
      computeSummaryAggregate(LEGACY_SKEW_ROWS, true).invocationsExact
    ).toBe(false);
    expect(
      computeSummaryAggregate(LEGACY_SKEW_ROWS, false).invocationsExact
    ).toBe(true);
  });
});

/**
 * ISS-6409 — LOC/$ is a ratio of sums, folded over the session UNION by the
 * producer (Cosimo, 2026-09-01).
 *
 * The reduction no longer derives LOC/$ from rows at all. It cannot: one
 * session can invoke several subagents and each component's terms count that
 * session's full LOC and cost, so summing per-row terms weights a shared
 * session once per component that used it — a third estimand under a label that
 * promises comparability with the Sessions and Branches cards (#6417 review).
 * These cases pin the seam; the folds themselves are covered beside each
 * producer.
 */
describe("LOC/$ comes from the producer fold", () => {
  const rows = [
    makeComponent({ id: "a", slug: "subagent::a", locPerDollar: 30 }),
    makeComponent({ id: "b", slug: "subagent::b", locPerDollar: 1300 }),
  ];

  it("reports the fold's figure, not any function of the rows", () => {
    // 30 and 1300 are the rows' own ratios. Neither their mean (665) nor any
    // sum of them is 42 — so a reduction that fell back to deriving from rows
    // fails here rather than quietly producing a plausible number.
    const aggregate = computeSummaryAggregate(rows, false, () => ({
      locPerDollar: 42,
      sampleSize: 2,
    }));

    expect(aggregate.locPerDollar).toBe(42);
    expect(aggregate.locPerDollarSampleSize).toBe(2);
  });

  it("passes the reduction's own filtered population to the fold", () => {
    // The card must describe the rows it sits above, so the fold has to receive
    // exactly those rows — not the unfiltered inventory.
    const seen: string[][] = [];
    computeSummaryAggregate(rows, false, (components) => {
      seen.push(components.map((c) => c.slug));
      return { locPerDollar: 1, sampleSize: components.length };
    });

    expect(seen).toEqual([["subagent::a", "subagent::b"]]);
  });

  it("is unavailable, not zero, when no producer supplied a fold", () => {
    // The browser's legacy client-side reduction. From rows alone the union is
    // not recoverable, and a differently-weighted number under this label is
    // worse than a dash.
    const aggregate = computeSummaryAggregate(rows);

    expect(aggregate.locPerDollar).toBeNull();
    expect(aggregate.locPerDollarSampleSize).toBe(0);
  });

  it("routes each window's own population to that window's fold", () => {
    // ISS-6409 (#6417 review): a fold closes over ONE window's session maps, so
    // the pair takes one per side. It used to take a single fold and hand it to
    // both, which made the preceding window report the current window's figure
    // and the card's delta read 0% against itself.
    //
    // Each closure answers FROM the components it receives, not a constant:
    // constants would still pass if the pair handed the current window's
    // population to `previous`, which is the half of the bug that silently
    // drops components the current window lacks.
    const previous = [makeComponent({ id: "p", slug: "subagent::p" })];
    const seenByCurrent: string[][] = [];
    const seenByPrevious: string[][] = [];
    const rate = (slugs: string[]) => (slugs.includes("subagent::p") ? 5 : 10);

    const pair = computeSummaryAggregatePair(rows, previous, false, {
      current: (cs) => {
        const slugs = cs.map((c) => c.slug);
        seenByCurrent.push(slugs);
        return { locPerDollar: rate(slugs), sampleSize: cs.length };
      },
      previous: (cs) => {
        const slugs = cs.map((c) => c.slug);
        seenByPrevious.push(slugs);
        return { locPerDollar: rate(slugs), sampleSize: cs.length };
      },
    });

    expect(pair.current?.locPerDollar).toBe(10);
    expect(pair.previous?.locPerDollar).toBe(5);
    // The populations themselves, so a swap cannot hide behind the rates.
    expect(seenByCurrent).toEqual([["subagent::a", "subagent::b"]]);
    expect(seenByPrevious).toEqual([["subagent::p"]]);
  });

  it("keeps a null fold result distinct from a zero", () => {
    const aggregate = computeSummaryAggregate(rows, false, () => ({
      locPerDollar: null,
      sampleSize: 0,
    }));

    expect(aggregate.locPerDollar).toBeNull();
    expect(aggregate.locPerDollar).not.toBe(0);
  });
});
