import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels";
import type { ActivitySegment } from "@repo/api/src/types/agent-session";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { UNATTRIBUTED_KEY } from "@repo/lib/branches/activity-rollup";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ActivityBreakdownSlot } from "../../../lib/session-activity-phases";
import {
  NO_RESIDUAL_INDEX,
  withUnattributedResidual,
} from "../activity-breakdown-residual";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  SessionActivityBreakdown,
  UNKNOWN_CELL,
} from "../session-activity-breakdown";
import { activitySegmentFixture as segment } from "./activity-segment-fixtures";

/**
 * ISS-5128 — the Activity breakdown presented `sum(segments)` as the session
 * total in Derived mode. On a partially-attributed session that is the
 * attributed SLICE, not the session: production VQA found $4.46 rendered as the
 * total against a $508.75 Properties/API cost, a 114x gap with no row
 * explaining it.
 *
 * The shape matrix below is the one the ticket asked for — fully attributed,
 * partially attributed, wholly unattributed, and cost-unavailable — plus the two
 * cases the fix must NOT act on (sub-cent drift, over-attribution), plus the
 * four the #4395 review added: a TRUNCATED session (where the shortfall is not
 * unattributed spend at all), the half-cent boundary the old guard rounded away,
 * a producer-sent `unattributed` segment the residual has to fold into rather
 * than duplicate, and the Time/Tokens cells that read a residual's placeholder
 * zero as a measurement.
 */

// The production shape: segments priced over fewer token events than the
// session's own cost rollup covered, leaving a small attributed sum under a much
// larger session cost.
const PARTIAL_SEGMENTS: ActivitySegment[] = [
  segment({ key: "implement", costUsd: 3.2, durationMs: 900_000 }),
  segment({ key: "review", costUsd: 1.26, durationMs: 300_000 }),
];
const PARTIAL_ATTRIBUTED_USD = 4.46;
const PARTIAL_SESSION_USD = 508.75;

/**
 * The half-cent boundary (wongk, #4395). `4.465 - 4.46` is
 * `0.004999999999999893` in binary, so rounding the DIFFERENCE gives 0 cents and
 * the old guard suppressed the row, while the 2dp formatter renders the same two
 * numbers as $4.47 and $4.46. The panel would have hidden a whole visible cent
 * of disagreement with the Properties strip.
 */
const HALF_CENT_SESSION_USD = 4.465;
const HALF_CENT_HEADER = "$4.47";
const HALF_CENT_RESIDUAL = "$0.01";

const MONEY_CELL_RE = /^\$([\d,]+\.\d{2})$/;
const COMMA_RE = /,/g;
/** The residual footer sentence, matched on its load-bearing clause. */
const RESIDUAL_FOOTER_RE = /no phase attribution/i;
const TRUNCATION_FOOTER_RE = /later phases are cut off/i;

/**
 * Cell positions inside a `BreakdownRow` `<li>`: dot, phase, provenance,
 * confidence, time, tokens, cost, share. Read positionally because the Time and
 * Tokens cells carry no `data-slot` of their own — the shared anchors
 * (`ActivityBreakdownSlot`) cover the phase name and the cost cell only.
 */
const TIME_CELL_INDEX = 4;
const TOKENS_CELL_INDEX = 5;

function parseMoney(text: string): number {
  const match = MONEY_CELL_RE.exec(text.trim());
  if (!match) {
    throw new Error(`Not a money cell: ${text}`);
  }
  return Number(match[1].replace(COMMA_RE, ""));
}

function renderedHeaderTotal(container: HTMLElement): number {
  const header = container.querySelector("h2")?.parentElement;
  return parseMoney(header?.querySelector("span")?.textContent ?? "");
}

function renderedPhaseCosts(container: HTMLElement): number[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-slot="${ActivityBreakdownSlot.CostCell}"]`
    )
  ).map((cell) => parseMoney(cell.textContent ?? ""));
}

function renderedPhaseNames(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-slot="${ActivityBreakdownSlot.PhaseName}"]`
    )
  ).map((cell) => cell.textContent?.trim() ?? "");
}

/** Every rendered row whose phase name is the canonical unattributed label. */
function unattributedRows(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-slot="${ActivityBreakdownSlot.PhaseName}"]`
    )
  )
    .filter(
      (cell) => cell.textContent?.trim() === ACTIVITY_PHASE_LABEL.unattributed
    )
    .map((cell) => cell.closest("li"))
    .filter((row): row is HTMLLIElement => row !== null);
}

function cellText(row: HTMLElement, index: number): string {
  return row.children[index]?.textContent?.trim() ?? "";
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

/**
 * ISS-5366 retired the ISS-5000 gate this used to seed, so no flag is enabled
 * here any more. The provider stays because the panel still needs one to mount.
 */
function renderWithFlag(node: ReactNode) {
  return render(node, {
    wrapper: ({ children }) => (
      <AppCoreStoryProviders>{children}</AppCoreStoryProviders>
    ),
  });
}

describe("SessionActivityBreakdown — ISS-5128 unattributed residual", () => {
  it("reconciles a PARTIALLY attributed session's total to the session cost", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: PARTIAL_SEGMENTS,
      estimatedCost: PARTIAL_SESSION_USD,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    // The defect: this read $4.46 — the attributed slice — under a $508.75
    // session. The header must now be the session's own cost.
    expect(toCents(renderedHeaderTotal(container))).toBe(
      toCents(PARTIAL_SESSION_USD)
    );
  });

  it("carries the missing spend in a visible row rather than only fixing the header", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: PARTIAL_SEGMENTS,
      estimatedCost: PARTIAL_SESSION_USD,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    // The header stays the sum of the column (ISS-4446 in the other direction):
    // reconciling by moving the header alone would leave a total that provably
    // is not the sum of the rows beneath it.
    const costs = renderedPhaseCosts(container);
    expect(costs).toHaveLength(PARTIAL_SEGMENTS.length + 1);
    expect(costs.reduce((sum, value) => sum + toCents(value), 0)).toBe(
      toCents(renderedHeaderTotal(container))
    );
    // And the remainder is named, not silently folded into a phase.
    expect(toCents(costs.at(-1) ?? 0)).toBe(
      toCents(PARTIAL_SESSION_USD - PARTIAL_ATTRIBUTED_USD)
    );
  });

  it("adds NO residual row when the tiling already attributes the whole session", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: PARTIAL_SEGMENTS,
      estimatedCost: PARTIAL_ATTRIBUTED_USD,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    expect(renderedPhaseCosts(container)).toHaveLength(PARTIAL_SEGMENTS.length);
    expect(toCents(renderedHeaderTotal(container))).toBe(
      toCents(PARTIAL_ATTRIBUTED_USD)
    );
  });
});

/**
 * #4395 review. On a TRUNCATED session `activitySegments` is a start-ordered
 * prefix while `estimatedCost` stays the full stored rollup, so the shortfall is
 * the cost of phases that WERE attributed and merely got cut off. Filing that
 * under a row `activity-phase-labels.ts` defines as spend the classifier never
 * observed says the opposite of what happened, and it lands directly above a
 * footer still telling the reader these totals cover only the phases shown.
 */
describe("SessionActivityBreakdown — truncated sessions get no residual", () => {
  const truncatedSession = () =>
    createAgentSessionDetailFixture({
      activitySegmentRowsTruncated: true,
      activitySegments: PARTIAL_SEGMENTS,
      estimatedCost: PARTIAL_SESSION_USD,
    });

  it("keeps the header at the RETAINED phases' cost", () => {
    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={truncatedSession()} />
    );

    expect(toCents(renderedHeaderTotal(container))).toBe(
      toCents(PARTIAL_ATTRIBUTED_USD)
    );
    expect(renderedPhaseCosts(container)).toHaveLength(PARTIAL_SEGMENTS.length);
  });

  it("never labels cut-off phases as unattributed, and keeps saying coverage is partial", () => {
    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={truncatedSession()} />
    );

    // The two statements that would have contradicted each other on the same
    // panel: an Unattributed row holding the cut-off spend, and a footer saying
    // the cut-off phases are simply not shown.
    expect(renderedPhaseNames(container)).not.toContain(
      ACTIVITY_PHASE_LABEL.unattributed
    );
    expect(container.textContent).toMatch(TRUNCATION_FOOTER_RE);
    expect(container.textContent).not.toMatch(RESIDUAL_FOOTER_RE);
  });
});

/**
 * #4395 review (wongk). Rounding the DIFFERENCE hides a cent the reader can see
 * on the Properties strip; each total has to be quantized the way the formatter
 * quantizes it, then subtracted.
 */
describe("SessionActivityBreakdown — the half-cent boundary", () => {
  const halfCentSession = () =>
    createAgentSessionDetailFixture({
      activitySegments: [
        segment({ key: "implement", costUsd: 4.46, durationMs: 900_000 }),
      ],
      estimatedCost: HALF_CENT_SESSION_USD,
    });

  it("shows the cent the old guard rounded away", () => {
    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={halfCentSession()} />
    );

    const header = container.querySelector("h2")?.parentElement;
    expect(header?.querySelector("span")?.textContent?.trim()).toBe(
      HALF_CENT_HEADER
    );
    const costs = renderedPhaseCosts(container);
    expect(costs).toHaveLength(2);
    expect(costs.at(-1)).toBe(parseMoney(HALF_CENT_RESIDUAL));
  });

  it("returns a residual index for the same boundary at the unit level", () => {
    const result = withUnattributedResidual(
      [segment({ key: "implement", costUsd: 4.46 })],
      createAgentSessionDetailFixture({ estimatedCost: HALF_CENT_SESSION_USD })
    );

    expect(result.residualIndex).not.toBe(NO_RESIDUAL_INDEX);
  });
});

/**
 * #4395 review. `BreakdownRow` had an unknown affordance for Cost and Tokens but
 * none for Time, so the row carrying $504 of a $508 session rendered
 * `formatCoarseDurationMs(0)` and read as having taken zero seconds. A dash and
 * a true zero must stay visibly distinct, and this was the row where they had
 * collapsed.
 */
describe("SessionActivityBreakdown — the residual row's unknown Time and Tokens", () => {
  it("renders a dash, not 0s and not 0 tokens, on the residual row", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: PARTIAL_SEGMENTS,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: PARTIAL_SESSION_USD,
      inputTokens: 0,
      outputTokens: 0,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    const [residual] = unattributedRows(container);
    expect(residual).toBeDefined();
    expect(cellText(residual, TIME_CELL_INDEX)).toBe(UNKNOWN_CELL);
    expect(cellText(residual, TOKENS_CELL_INDEX)).toBe(UNKNOWN_CELL);
  });

  it("still renders REAL token counts when the residual has them", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: PARTIAL_SEGMENTS,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: PARTIAL_SESSION_USD,
      inputTokens: 5000,
      outputTokens: 0,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    const [residual] = unattributedRows(container);
    // Time is still unknown (no attributable span), tokens are not.
    expect(cellText(residual, TIME_CELL_INDEX)).toBe(UNKNOWN_CELL);
    expect(cellText(residual, TOKENS_CELL_INDEX)).not.toBe(UNKNOWN_CELL);
  });

  it("leaves a real phase's measured zero alone", () => {
    // The dash is scoped to the residual row. A tiled phase that genuinely spent
    // no measurable time still reports it, or the panel would start calling real
    // measurements unknown.
    const session = createAgentSessionDetailFixture({
      activitySegments: [
        segment({ key: "implement", costUsd: 3.2, durationMs: 900_000 }),
        segment({ key: "review", costUsd: 1.26, durationMs: 0 }),
      ],
      estimatedCost: PARTIAL_SESSION_USD,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    const reviewRow = Array.from(
      container.querySelectorAll<HTMLElement>("li")
    ).find((row) =>
      row
        .querySelector(`[data-slot="${ActivityBreakdownSlot.PhaseName}"]`)
        ?.textContent?.includes(ACTIVITY_PHASE_LABEL.review)
    );
    expect(reviewRow).toBeDefined();
    expect(cellText(reviewRow as HTMLElement, TIME_CELL_INDEX)).not.toBe(
      UNKNOWN_CELL
    );
  });
});

/** #4395 review. Nothing on screen explained the new row. */
describe("SessionActivityBreakdown — the footer explains the residual", () => {
  it("names the row when a residual is present", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: PARTIAL_SEGMENTS,
      estimatedCost: PARTIAL_SESSION_USD,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    expect(container.textContent).toMatch(RESIDUAL_FOOTER_RE);
    expect(container.textContent).toContain(ACTIVITY_PHASE_LABEL.unattributed);
  });

  it("stays quiet when the session is fully attributed", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: PARTIAL_SEGMENTS,
      estimatedCost: PARTIAL_ATTRIBUTED_USD,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    expect(container.textContent).not.toMatch(RESIDUAL_FOOTER_RE);
  });
});

/**
 * #4395 review (wongk). `phase` is a bounded FREE STRING on the wire, not the
 * closed taxonomy, so the producer can already send a segment under the
 * unattributed key. Appending a second rendered two rows meaning the same thing
 * under one React key.
 */
describe("SessionActivityBreakdown — folding into a producer-sent unattributed row", () => {
  const WIRE_UNATTRIBUTED: ActivitySegment[] = [
    segment({ key: "implement", costUsd: 3.2, durationMs: 900_000 }),
    segment({
      inputTokens: 100,
      key: UNATTRIBUTED_KEY,
      costUsd: 1.26,
      durationMs: 300_000,
    }),
  ];

  it("renders exactly ONE unattributed row", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: WIRE_UNATTRIBUTED,
      estimatedCost: PARTIAL_SESSION_USD,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    expect(unattributedRows(container)).toHaveLength(1);
    expect(renderedPhaseCosts(container)).toHaveLength(
      WIRE_UNATTRIBUTED.length
    );
  });

  it("folds the residual into that row's cost rather than appending", () => {
    const result = withUnattributedResidual(
      WIRE_UNATTRIBUTED,
      createAgentSessionDetailFixture({ estimatedCost: PARTIAL_SESSION_USD })
    );

    expect(result.segments).toHaveLength(WIRE_UNATTRIBUTED.length);
    expect(result.residualIndex).toBe(1);
    expect(toCents(result.segments[1].costUsd)).toBe(
      toCents(PARTIAL_SESSION_USD - 3.2)
    );
    // The measured span the classifier DID attribute survives the fold.
    expect(result.segments[1].durationMs).toBe(300_000);
  });

  it("keeps the folded row's measured time rather than dashing it out", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: WIRE_UNATTRIBUTED,
      estimatedCost: PARTIAL_SESSION_USD,
    });

    const { container } = renderWithFlag(
      <SessionActivityBreakdown session={session} />
    );

    const [folded] = unattributedRows(container);
    expect(cellText(folded, TIME_CELL_INDEX)).not.toBe(UNKNOWN_CELL);
  });
});

describe("withUnattributedResidual — the cases it must not act on", () => {
  const session = (estimatedCost: number) =>
    createAgentSessionDetailFixture({ estimatedCost });

  it("appends the residual when the session cost exceeds the attributed sum", () => {
    const result = withUnattributedResidual(
      PARTIAL_SEGMENTS,
      session(PARTIAL_SESSION_USD)
    );

    expect(result.segments).toHaveLength(PARTIAL_SEGMENTS.length + 1);
    expect(result.residualIndex).toBe(PARTIAL_SEGMENTS.length);
    expect(toCents(result.segments.at(-1)?.costUsd ?? 0)).toBe(
      toCents(PARTIAL_SESSION_USD - PARTIAL_ATTRIBUTED_USD)
    );
    // No attributable TIME — synthesizing a span would invent wall-clock the
    // classifier never saw. The renderer turns this into a dash.
    expect(result.segments.at(-1)?.durationMs).toBe(0);
    expect(result.segments.at(-1)?.isUnclassified).toBe(true);
  });

  it("ignores a sub-cent residual the column could not render anyway", () => {
    // ISS-5000 already redistributes rounding drift; a row reading $0.00 would
    // be noise the reader cannot act on.
    const result = withUnattributedResidual(
      PARTIAL_SEGMENTS,
      session(PARTIAL_ATTRIBUTED_USD + 0.001)
    );

    expect(result.segments).toHaveLength(PARTIAL_SEGMENTS.length);
    expect(result.residualIndex).toBe(NO_RESIDUAL_INDEX);
  });

  it("refuses to invent a NEGATIVE row when the segments over-attribute", () => {
    // Over-attribution is a real inconsistency, but it is not dropped spend, and
    // a negative row would be a fabricated value rather than a disclosure.
    const result = withUnattributedResidual(
      PARTIAL_SEGMENTS,
      session(PARTIAL_ATTRIBUTED_USD - 1)
    );

    expect(result.segments).toHaveLength(PARTIAL_SEGMENTS.length);
    expect(result.residualIndex).toBe(NO_RESIDUAL_INDEX);
  });

  it("adds nothing for an unpriced session with no cost to reconcile against", () => {
    const result = withUnattributedResidual(PARTIAL_SEGMENTS, session(0));

    expect(result.segments).toHaveLength(PARTIAL_SEGMENTS.length);
    expect(result.residualIndex).toBe(NO_RESIDUAL_INDEX);
  });

  it("adds nothing when the attributed sum is not a finite number", () => {
    // The upstream token-event aggregation preserves whatever it was handed, so
    // a non-finite phase cost is reachable data. Degrading beats subtracting
    // against a NaN and rendering the result.
    const result = withUnattributedResidual(
      [segment({ key: "implement", costUsd: Number.NaN })],
      session(PARTIAL_SESSION_USD)
    );

    expect(result.segments).toHaveLength(1);
    expect(result.residualIndex).toBe(NO_RESIDUAL_INDEX);
  });

  it("floors the token residual at zero rather than reporting a negative count", () => {
    const rich: ActivitySegment[] = [
      segment({
        key: "implement",
        costUsd: 1,
        durationMs: 1000,
        inputTokens: 900,
        outputTokens: 900,
      }),
    ];
    const target = createAgentSessionDetailFixture({
      estimatedCost: 100,
      inputTokens: 100,
      outputTokens: 100,
    });

    const residual = withUnattributedResidual(rich, target).segments.at(-1);

    expect(residual?.inputTokens).toBe(0);
    expect(residual?.outputTokens).toBe(0);
  });
});
