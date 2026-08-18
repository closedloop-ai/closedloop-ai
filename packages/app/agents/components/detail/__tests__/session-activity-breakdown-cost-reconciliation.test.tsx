import type { ActivitySegment } from "@repo/api/src/types/agent-session";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ActivityBreakdownSlot } from "../../../lib/session-activity-phases";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionActivityBreakdown } from "../session-activity-breakdown";
import { activitySegmentFixture as segment } from "./activity-segment-fixtures";

/**
 * ISS-5000 — the Cost column is presented as the decomposition of the header
 * figure ("Shares are by cost, not time."), so it has to add up to it.
 *
 * The existing "reconciles the header total to the sum of per-phase cost" case
 * above could not catch this: its fixture uses clean values (1.00 / 3.00 / 0 /
 * 0.82) that survive independent rounding intact, and it only reads the header.
 * These fixtures carry sub-cent tails — the shape of real token-priced spend —
 * and assert on what the COLUMN renders.
 */
// The SES-78747 values behind the finding: independently rounded they render
// $24.79 + $3.40 + $3.25 + $0.00 + $1.40 = $32.84 under a $32.86 header.
const SUB_CENT_SEGMENTS: ActivitySegment[] = [
  segment({ key: "review", costUsd: 24.7949, durationMs: 1_320_000 }),
  segment({ key: "implement", costUsd: 3.4049, durationMs: 1_140_000 }),
  segment({ key: "validate", costUsd: 3.2549, durationMs: 720_000 }),
  segment({ key: "idle", costUsd: 0, durationMs: 1_200_000 }),
  segment({ key: "explore", costUsd: 1.4049, durationMs: 600_000 }),
];

const MONEY_CELL_RE = /^\$([\d,]+\.\d{2})$/;

function parseMoney(text: string): number {
  const match = MONEY_CELL_RE.exec(text.trim());
  if (!match) {
    throw new Error(`Not a money cell: ${text}`);
  }
  return Number(match[1].replace(/,/g, ""));
}

function renderedPhaseCosts(container: HTMLElement): number[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-slot="${ActivityBreakdownSlot.CostCell}"]`
    )
  ).map((cell) => parseMoney(cell.textContent ?? ""));
}

function renderedHeaderTotal(container: HTMLElement): number {
  const header = container.querySelector("h2")?.parentElement;
  const total = header?.querySelector("span")?.textContent ?? "";
  return parseMoney(total);
}

// Cents, so the comparison is on the integers the user actually reads rather
// than on floats that can differ below the rendered precision.
function toCents(value: number): number {
  return Math.round(value * 100);
}

describe("SessionActivityBreakdown — ISS-5000 cost reconciliation", () => {
  const session = () =>
    createAgentSessionDetailFixture({ activitySegments: SUB_CENT_SEGMENTS });

  function renderWithHonestStates(node: ReactNode) {
    return render(node, {
      wrapper: ({ children }) => (
        <AppCoreStoryProviders>{children}</AppCoreStoryProviders>
      ),
    });
  }

  it("makes the rendered phase costs sum to the rendered header total", () => {
    const { container } = renderWithHonestStates(
      <SessionActivityBreakdown session={session()} />
    );

    const phaseCosts = renderedPhaseCosts(container);
    expect(phaseCosts).toHaveLength(SUB_CENT_SEGMENTS.length);
    expect(phaseCosts.reduce((sum, value) => sum + toCents(value), 0)).toBe(
      toCents(renderedHeaderTotal(container))
    );
  });

  it("keeps the header on the true total rather than lowering it to a lossy column", () => {
    // The header is the exact sum of the unrounded attribution and agrees with
    // the Properties strip, so the fix must not "reconcile" by moving IT.
    const { container } = renderWithHonestStates(
      <SessionActivityBreakdown session={session()} />
    );
    const exactTotal = SUB_CENT_SEGMENTS.reduce(
      (sum, seg) => sum + seg.costUsd,
      0
    );
    expect(toCents(renderedHeaderTotal(container))).toBe(toCents(exactTotal));
  });

  it("does not move a phase by more than the rounding it absorbs", () => {
    const { container } = renderWithHonestStates(
      <SessionActivityBreakdown session={session()} />
    );
    const phaseCosts = renderedPhaseCosts(container);
    for (const [index, rendered] of phaseCosts.entries()) {
      const attributed = SUB_CENT_SEGMENTS[index].costUsd;
      expect(Math.abs(rendered - attributed)).toBeLessThanOrEqual(0.01);
    }
  });
});
