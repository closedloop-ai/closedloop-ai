import { TraceScrollOutcome } from "@repo/app/agents/lib/trace-scroll-target";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { getDotJumpRow } from "../activity-dot-rendering";
import { buildDotCells } from "../session-timeline-dot-cells";
import { SessionTimelineDotRail } from "../session-timeline-dot-rail";
import {
  createDotRailStageBuckets,
  createSessionTraceScenario,
} from "../session-trace-scenario-fixture";

/**
 * ISS-8657: the trouble lane's first member must be the bucket's FIRST event.
 *
 * `buildDotCells` appended the limit dots in a second pass, so every limit
 * landed after every failure sharing a bucket regardless of when either
 * happened. `getDotJumpRow` takes the lane's first member — the event the rail's
 * click actually targets — so a bucket holding a 09:01 limit and a 09:04 failure
 * resolved to the FAILURE: the last event, named as the first.
 *
 * BOTH DIRECTIONS ARE PINNED. A fix that merely sorted the other way would pass
 * the first spec and fail the second, so the pair is what rules out swapping the
 * bug rather than fixing it.
 *
 * This does NOT settle what a dot should target (ISS-8653 / ISS-8656 own that
 * question). It only requires that whatever "first" means, it is not "last".
 */

const BUCKET_COUNT = 1;
const LIMIT_ROW = 1;
const FAIL_ROW = 2;

describe("dot cell ordering (ISS-8657)", () => {
  it("resolves a bucket's earlier limit ahead of its later failure", () => {
    const lane = troubleLane(createSessionTraceScenario());

    expect(lane[0]).toMatchObject({
      kind: "limit",
      label: "Rate limit reached",
      tl: LIMIT_ROW,
    });
    expect(getDotJumpRow(lane)).toBe(LIMIT_ROW);
  });

  it("resolves a bucket's earlier failure ahead of its later limit", () => {
    const lane = troubleLane(
      createSessionTraceScenario({
        failOffsetMs: 60_000,
        limitOffsetMs: 240_000,
      })
    );

    expect(lane[0]).toMatchObject({
      kind: "fail",
      label: "Ran 3 tools",
      tl: FAIL_ROW,
    });
    expect(getDotJumpRow(lane)).toBe(FAIL_ROW);
  });

  /*
   * The production wiring, in BOTH directions. The pure specs above pin the
   * resolution; these drive the rail the reader actually clicks, so deleting the
   * ordering at the call site cannot leave them green on their own — and running
   * both directions here, not just the limit-first one, means the wiring is
   * proved for the case the ordering had to be taught as well as the case it
   * already got right.
   */
  it.each([
    { expectedRow: LIMIT_ROW, first: "limit", overrides: {} },
    {
      expectedRow: FAIL_ROW,
      first: "fail",
      overrides: { failOffsetMs: 60_000, limitOffsetMs: 240_000 },
    },
  ])(
    "clicking the trouble dot jumps to the bucket's first event ($first first)",
    async ({ expectedRow, overrides }) => {
      const onJump = vi.fn();
      const scenario = createSessionTraceScenario(overrides);
      render(
        <SessionTimelineDotRail
          buckets={createDotRailStageBuckets(BUCKET_COUNT)}
          cells={buildDotCells(
            scenario.markers,
            scenario.limitDotEvents,
            BUCKET_COUNT
          )}
          disabled={false}
          hoverDot={null}
          onHoverDot={vi.fn()}
          onJump={onJump}
        />
      );

      await userEvent.click(
        screen.getByRole("button", { name: "Jump to Failures & limits" })
      );

      expect(onJump).toHaveBeenCalledWith(
        expectedRow,
        true,
        TraceScrollOutcome.Unresolvable
      );
    }
  );
});

function troubleLane(scenario: ReturnType<typeof createSessionTraceScenario>) {
  return buildDotCells(
    scenario.markers,
    scenario.limitDotEvents,
    BUCKET_COUNT
  )[0].r;
}
