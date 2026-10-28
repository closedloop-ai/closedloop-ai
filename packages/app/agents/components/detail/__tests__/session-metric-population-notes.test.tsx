import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionPropertiesPanel } from "../session-properties-panel";

/**
 * ISS-7737 — session `795c67ae` reports 8,260,678,836 tokens / $6,229.94 four
 * rows from a Work row saying 1,016 turns, and the panel said nothing about
 * either population. Both figures are right: `agent_turns` counts the PARENT
 * transcript, the token and cost rollup folds in every delegated subagent
 * transcript (38,844 billable round-trips). Nothing in the product performs the
 * division, but two investigators did it by hand off this very panel and both
 * reported the resulting 7.87M cache reads per turn as physically impossible.
 *
 * Marisol Ashgrove ruled on 2026-08-23: ANNOTATE BOTH. Every figure stays where it
 * is and keeps its value; each says what it counts. The load-bearing case here
 * is therefore not the sentences on their own — it is {@link describe} "the
 * ruling's other half", which renders the panel with the gate OFF and ON and
 * compares THE TWO RENDERS TO EACH OTHER. Checking each against a constant would
 * keep passing if the annotated render quietly dropped or reordered a row, which
 * is the exact outcome the ruling forbids.
 *
 * The three sentences are pinned as literals written independently of
 * `session-population-notes.ts`. Importing the constants would assert that the
 * rows render whatever that module currently says — copy is the operator's call,
 * so a one-sided edit has to fail here.
 */

const TURNS_NOTE = "Turns counts parent turns";
const TOKENS_NOTE = "Tokens counts all round-trips, including delegated work";
const COST_NOTE = "Cost covers all round-trips, including delegated work";

const PROPERTIES_TOGGLE_RE = /Properties/;
const WORK_LABEL = "Work";
const TOKENS_LABEL = "Tokens";
const COST_LABEL = "Cost";

/**
 * The ticket's own session, at its real magnitudes: a parent-only turn count
 * beside a subagent-folded rollup, with a priced cost so the Cost row renders a
 * figure rather than the `CostAvailability` dash.
 */
const FOLDED_SESSION = createAgentSessionDetailFixture(foldedOverrides());

/**
 * The same magnitudes, reused by the subscription case. Split out so that case
 * differs from {@link FOLDED_SESSION} by `billingMode` ALONE — a second
 * hand-authored literal could drift and quietly test a different session.
 */
const SUBSCRIPTION_OVERRIDES = foldedOverrides();

/**
 * A session that recorded no token usage at all — the shape BOTH producers emit
 * (four coalesced zeros, never nulls), with a turn and a tool use so it is not
 * dismissed as never having run.
 */
const ZERO_USAGE_SESSION = createAgentSessionDetailFixture({
  cache: 0,
  cacheReadTokens: 0,
  cacheWrite: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolUseCount: 1,
  tokensIn: 0,
  tokensOut: 0,
  turns: 1,
});

/**
 * The ticket's session with its RECORDED turn count removed. `turnItems` is left
 * exactly as the shared fixture ships it (seven heterogeneous render rows), so
 * the Work row falls back to `turnItems.length` — the case the parent-turn
 * sentence must not claim.
 */
const FALLBACK_TURN_COUNT_SESSION = createAgentSessionDetailFixture({
  ...foldedOverrides(),
  turns: null,
});

describe("ISS-7737 each session-detail figure names the population it counts", () => {
  it("puts the parent-turn sentence on the row that shows the turn count", async () => {
    await renderPanel({ disclosed: true });

    // Asserted on the value element itself, not on the row: the sentence has to
    // travel WITH the figure, so the same node has to carry both. A note that
    // detached into a sibling would still satisfy a row-level `toContain`.
    expect(valueTextOf(WORK_LABEL)).toContain("1016 turns");
    expect(valueTextOf(WORK_LABEL)).toContain(TURNS_NOTE);
  });

  it("withholds the parent-turn sentence when the count fell back to turnItems", async () => {
    // `session.turns` absent, so the Work row falls back to `turnItems.length`.
    // Those are RENDER ROWS from a six-variant union — the fixture's own seven
    // entries are prompt, say, say, tools, event, subagent, end — so the number
    // is neither a recorded turn count nor parent-only. Naming it "parent turns"
    // would vouch for a population it does not describe.
    await renderPanel({
      disclosed: true,
      session: FALLBACK_TURN_COUNT_SESSION,
    });

    // Positive control on the SAME selector the absence is asserted against: the
    // row really did render the fallback figure, so the missing sentence is the
    // gate declining to vouch for it and not an empty row.
    expect(valueTextOf(WORK_LABEL)).toContain("7 turns");
    expect(valueTextOf(WORK_LABEL)).not.toContain(TURNS_NOTE);
  });

  it("puts the folded-round-trip sentence on Tokens and on Cost", async () => {
    await renderPanel({ disclosed: true });

    expect(valueTextOf(TOKENS_LABEL)).toContain("7,994,296,736 cache read");
    expect(valueTextOf(TOKENS_LABEL)).toContain(TOKENS_NOTE);
    expect(valueTextOf(COST_LABEL)).toContain("$6,229.94");
    expect(valueTextOf(COST_LABEL)).toContain(COST_NOTE);
  });

  it("states each population exactly once in the accessibility tree", async () => {
    await renderPanel({ disclosed: true });

    // ISS-4654's contract: the sentence is the row's ONE `sr-only` tail, never a
    // visible note plus a duplicate announcement. A second statement here is how
    // a screen reader ends up hearing the population twice per row.
    for (const label of [WORK_LABEL, TOKENS_LABEL, COST_LABEL]) {
      expect(srOnlyTailsOf(label)).toHaveLength(1);
    }
    expect(srOnlyTailsOf(WORK_LABEL)[0]?.textContent).toContain(TURNS_NOTE);
    expect(srOnlyTailsOf(TOKENS_LABEL)[0]?.textContent).toContain(TOKENS_NOTE);
    expect(srOnlyTailsOf(COST_LABEL)[0]?.textContent).toContain(COST_NOTE);
  });

  it("says nothing about either population with the gate closed", async () => {
    await renderPanel({ disclosed: false });

    // The dark-launch pole. Read off the whole panel rather than the three rows,
    // so a sentence that migrated to a neighbouring row still fails.
    const panel = document.body.textContent ?? "";
    expect(panel).not.toContain(TURNS_NOTE);
    expect(panel).not.toContain(TOKENS_NOTE);
    expect(panel).not.toContain(COST_NOTE);
    // Cost carried no `explanation` before this change, so it must still be the
    // plain truncating value rather than the explained button treatment.
    expect(srOnlyTailsOf(COST_LABEL)).toHaveLength(0);
  });

  /**
   * Review catch. `Subscription` is not a word-rendering state: `formatCostLabel`
   * runs it through the SAME `formatCost` call as `Available`, and
   * `deriveCostAvailability` reaches it BEFORE the `estimatedCost > 0` test, so
   * every subscription-billed session with real folded spend lands there. Gating
   * the sentence on `Available` alone annotated Turns and Tokens and then went
   * silent on the dollars four rows down — for Claude Pro/Max desktop sessions,
   * which is the population this ticket came from.
   */
  it("names the population on a subscription session, which shows dollars too", async () => {
    await renderPanel({
      session: createAgentSessionDetailFixture({
        ...SUBSCRIPTION_OVERRIDES,
        billingMode: "max_20x",
      }),
      disclosed: true,
    });

    // The row really is showing money — without this the assertion below could
    // pass on a dash that happens to carry a sentence.
    expect(valueTextOf(COST_LABEL)).toContain("$6,229.94");
    expect(valueTextOf(COST_LABEL)).toContain(COST_NOTE);
  });

  /**
   * Review catch. `recordedNothing` is the evidence question only while
   * ISS-5637's SEPARATE flag is on; with that flag off it falls back to a
   * per-counter null neither producer can emit, so a zero-usage session prints
   * four fabricated zeros. The two flags are independent keys and independent
   * Labs toggles, so this combination is one click away — and the sentence must
   * not vouch for those zeros as a count of every round-trip.
   */
  it("withholds the Tokens sentence from a zero-usage row, even with ISS-5637's gate closed", async () => {
    await renderPanel({ session: ZERO_USAGE_SESSION, disclosed: true });

    // The fabricated quadruple is exactly what this row still renders with the
    // honesty gate closed — asserted so the case cannot go green by rendering a
    // dash instead, which is a different (already-covered) state.
    expect(valueTextOf(TOKENS_LABEL)).toContain("0 in");
    expect(valueTextOf(TOKENS_LABEL)).not.toContain(TOKENS_NOTE);
    expect(srOnlyTailsOf(TOKENS_LABEL)).toHaveLength(0);
  });

  /**
   * The half of the ruling that is easy to lose: "no figure a reader can reach
   * is removed and no row moves." A lane that split the two figures onto
   * separate panels, or dropped the Turns row to kill the adjacency, would pass
   * every assertion above.
   */
  it("removes no figure and moves no row when the gate opens", async () => {
    const closed = await renderPanel({ disclosed: false });
    const closedRows = labelledValues();
    closed.unmount();

    await renderPanel({ disclosed: true });

    // Compared to the OTHER render, never to a hand-written expected list: a
    // constant would have to be edited to match whatever the panel became, which
    // is precisely the drift this case exists to catch.
    expect(labelledValues()).toEqual(closedRows);
    // …and the comparison was not vacuous.
    expect(closedRows.length).toBeGreaterThan(0);
    expect(closedRows).toContainEqual([
      WORK_LABEL,
      "1016 turns | 5 tool calls | 1 steers",
    ]);
  });
});

async function renderPanel({
  disclosed,
  session = FOLDED_SESSION,
}: {
  disclosed: boolean;
  session?: AgentSessionDetail;
}) {
  const view = render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: disclosed
          ? [SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <SessionPropertiesPanel session={session} />
    </FeatureFlagAdapterProvider>
  );
  // The rows under test live in the expanded panel; it starts collapsed.
  await userEvent.click(
    screen.getByRole("button", { name: PROPERTIES_TOGGLE_RE })
  );
  return view;
}

/** Session 795c67ae's real counters: 1,016 parent turns over the folded rollup. */
function foldedOverrides() {
  return {
    cache: 7_994_296_736,
    cacheReadTokens: 7_994_296_736,
    cacheWrite: 238_501_193,
    cacheWriteTokens: 238_501_193,
    estimatedCost: 6229.941_627_15,
    inputTokens: 97_223,
    outputTokens: 27_783_684,
    tokensIn: 97_223,
    tokensOut: 27_783_684,
    turns: 1016,
  } satisfies Partial<AgentSessionDetail>;
}

/** The `.prd-prop` row carrying `label`. */
function rowFor(label: string): HTMLElement {
  const row = screen.getByText(label).closest(".prd-prop");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`No property row for label ${label}`);
  }
  return row;
}

/**
 * The text of the row's VALUE element — the label stripped, the `sr-only` tail
 * kept, because the tail is the statement under test and the point is that ONE
 * element carries the figure and its population together.
 */
function valueTextOf(label: string): string {
  return rowFor(label).querySelector(".prd-prop-value")?.textContent ?? "";
}

/** Every `sr-only` announcement inside the row. There must be at most one. */
function srOnlyTailsOf(label: string): Element[] {
  return [...rowFor(label).querySelectorAll(".sr-only")];
}

/**
 * Every rendered property row as `[label, visible value]`, in DOM order. The
 * `sr-only` tail is stripped: it is the annotation, and this snapshot is the
 * evidence that the annotation changed nothing else.
 */
function labelledValues(): [string, string][] {
  return [...document.querySelectorAll(".prd-prop")].map((row) => {
    const clone = row.cloneNode(true) as HTMLElement;
    for (const srOnly of clone.querySelectorAll(".sr-only")) {
      srOnly.remove();
    }
    const label = clone.querySelector(".prd-prop-label")?.textContent ?? "";
    clone.querySelector(".prd-prop-label")?.remove();
    return [label, (clone.textContent ?? "").trim()];
  });
}
