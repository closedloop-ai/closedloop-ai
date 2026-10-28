import { SESSION_TRACE_IDLE_ROWS_FLAG_KEY } from "@repo/api/src/types/session-trace-idle-rows-flag";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTrace } from "../session-trace";
import {
  buildTraceGroupsWithIdleRows,
  getTraceGroupKey,
  groupIndexForRow,
  type TraceGroup,
} from "../session-trace-groups";
import { createSessionTraceScenario } from "../session-trace-scenario-fixture";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-8652: an idle span renders as a trace row carrying its own timing.
 *
 * The gap was never missing data. `buildMergedTrace` computes it, the branch
 * adapter converts it to a `{ type: "idle" }` turn item, and `buildTraceGroups`
 * threw it away in the loop's first guard — computed, adapted, discarded. So
 * this suite is not about a new derivation; it is about the last step.
 *
 * The row carries the WHOLE timing statement because an idle span has no
 * transcript row of its own to hang one on: the duration is the row.
 *
 * The literals below are duplicated on purpose rather than re-derived from
 * `formatIdleRowLabel` — an expectation computed by the code under test agrees
 * with it by construction and cannot fail.
 */

const IDLE_ROW_TEXT = "Idle gap · 3m";
const TRAILING_IDLE_ROW_TEXT = "Idle gap · 1h";
const TRAILING_IDLE_GAP_MS = 3_600_000;
const FAIL_ROW = 2;

describe("session trace idle rows (ISS-8652)", () => {
  it("renders the idle span as its own row, with its duration in that row", () => {
    const { container } = render(
      withProviders(
        <SessionTrace items={createSessionTraceScenario().traceItems} />,
        [SESSION_TRACE_IDLE_ROWS_FLAG_KEY]
      )
    );

    expect(screen.getByText(IDLE_ROW_TEXT)).toBeInTheDocument();
    // Position, not just presence: an idle row rendered first or last would
    // satisfy a bare `getByText` while describing a pause between the wrong two
    // turns.
    const rows = renderedRowText(container);
    expect(rowIndexOf(rows, "Rate limit reached")).toBeGreaterThanOrEqual(0);
    expect(rowIndexOf(rows, "Rate limit reached")).toBeLessThan(
      rowIndexOf(rows, IDLE_ROW_TEXT)
    );
    expect(rowIndexOf(rows, IDLE_ROW_TEXT)).toBeLessThan(
      rowIndexOf(rows, "Ran 3 tools")
    );
  });

  /*
   * The negative, on the SAME scenario with only the idle span removed. Without
   * the spec above this would be satisfied by a trace that never renders an idle
   * row at all; without THIS one, "always render an idle row" would satisfy the
   * spec above. Neither is a test on its own.
   */
  it("renders no idle row for a trace that has no idle span", () => {
    render(
      withProviders(
        <SessionTrace
          items={createSessionTraceScenario({ withIdleSpan: false }).traceItems}
        />,
        [SESSION_TRACE_IDLE_ROWS_FLAG_KEY]
      )
    );

    // The turns either side of the (absent) gap still render, so this is an
    // absence in a populated trace rather than an empty one.
    expect(screen.getByText("Rate limit reached")).toBeInTheDocument();
    expect(screen.getByText("Ran 3 tools")).toBeInTheDocument();
    expect(screen.queryByText(IDLE_ROW_TEXT)).toBeNull();
  });

  /*
   * The closed-by-default half of ISS-4779, driven through a MOUNTED provider
   * that simply does not carry the key — the real product shape. (An absent
   * provider also reads as off, but that is `useFeatureFlagEnabledOptional`'s
   * fallback rather than the gate.)
   */
  it("renders no idle row while the gate is closed", () => {
    render(
      withProviders(
        <SessionTrace items={createSessionTraceScenario().traceItems} />,
        []
      )
    );

    expect(screen.getByText("Rate limit reached")).toBeInTheDocument();
    expect(screen.queryByText(IDLE_ROW_TEXT)).toBeNull();
  });

  /*
   * The group shape itself, which no rendered assertion reaches. One gap can
   * never tell an incrementing ordinal from a constant, and `ordinal` is the
   * ONLY thing making a rowless group's React key unique — two idle spans
   * colliding on `idle-0` is a reconciliation bug the DOM specs above would not
   * notice.
   */
  it("gives each idle span its own group, key, and gap, in trace order", () => {
    const groups = buildTraceGroupsWithIdleRows(
      createSessionTraceScenario({
        trailingIdleGapMs: TRAILING_IDLE_GAP_MS,
      }).traceItems
    );

    expect(groups.map((group) => group.kind)).toStrictEqual([
      "msg",
      "event",
      "idle",
      "msg",
      "idle",
      "end",
    ]);
    const idleGroups = groups.filter(isIdleGroup);
    expect(idleGroups.map(getTraceGroupKey)).toStrictEqual([
      "idle-0",
      "idle-1",
    ]);
    expect(idleGroups.map((group) => group.gapMs)).toStrictEqual([
      180_000,
      TRAILING_IDLE_GAP_MS,
    ]);
  });

  /*
   * The scrub path the branch merged trace uses (`virtualize`, whose
   * `scrollToRow` resolves through `groupIndexForRow`). An idle group is rowless,
   * so it must be SKIPPED as a jump target while still occupying an index — a
   * `groupRowOf` that returned a row for it, or an index walk that ignored it,
   * would land the scrub on the wrong group.
   */
  it("skips idle groups as scrub targets while they still occupy an index", () => {
    const groups = buildTraceGroupsWithIdleRows(
      createSessionTraceScenario({
        trailingIdleGapMs: TRAILING_IDLE_GAP_MS,
      }).traceItems
    );

    // Index 3 is the failing tool turn — after the prompt, the limit event and
    // the first idle row.
    expect(groupIndexForRow(groups, FAIL_ROW)).toBe(3);
  });

  it("renders both idle rows when a trace has two gaps", () => {
    render(
      withProviders(
        <SessionTrace
          items={
            createSessionTraceScenario({
              trailingIdleGapMs: TRAILING_IDLE_GAP_MS,
            }).traceItems
          }
        />,
        [SESSION_TRACE_IDLE_ROWS_FLAG_KEY]
      )
    );

    expect(screen.getByText(IDLE_ROW_TEXT)).toBeInTheDocument();
    expect(screen.getByText(TRAILING_IDLE_ROW_TEXT)).toBeInTheDocument();
  });
});

/**
 * The trace's top-level rows in DOCUMENT ORDER, as the index each row's text can
 * be looked up by. `.st` is the trace root and each child is one rendered group,
 * so this is the reader's own top-to-bottom sequence rather than a query order.
 */
function renderedRowText(container: HTMLElement): string[] {
  const root = container.querySelector(".st");
  if (!root) {
    return [];
  }
  return Array.from(root.children).map((row) => row.textContent ?? "");
}

/**
 * Where a row carrying `needle` sits in that sequence. A row's text is not just
 * its message — an event row appends its clock stamp, a tools row its failure
 * pill — so this matches a substring rather than the whole cell.
 */
function rowIndexOf(rows: readonly string[], needle: string): number {
  return rows.findIndex((row) => row.includes(needle));
}

function isIdleGroup(
  group: TraceGroup
): group is Extract<TraceGroup, { kind: "idle" }> {
  return group.kind === "idle";
}
