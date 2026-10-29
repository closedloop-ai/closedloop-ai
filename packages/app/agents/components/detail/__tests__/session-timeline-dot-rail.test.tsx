import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DotColor } from "../activity-dot-rendering";
import type { ActivityMarker } from "../session-timeline-axis";
import { SessionTimelineDotRail } from "../session-timeline-dot-rail";
import {
  type HoverDot,
  SessionTimelineHoverCards,
} from "../session-timeline-strip-parts";

const CLICK_TO_JUMP_RE = /click the dot to jump/i;

describe("SessionTimelineDotRail", () => {
  it("keeps aggregate bucket/color semantics and first-member jumps", async () => {
    const onJump = vi.fn();
    renderRail({
      cells: [
        {
          ...emptyLanes(),
          g: [
            dotEvent("commit", "Commit pushed", 7),
            dotEvent("pr", "PR opened", 9),
          ],
        },
      ],
      onJump,
    });

    const marker = screen.getByRole("button", {
      name: "Jump to Commits & PRs",
    });
    expect(marker).toHaveClass("sd3-dot", "d-g");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(marker);
    expect(onJump).toHaveBeenCalledWith(7, true, "unresolvable");
  });

  it("keeps rowless aggregate markers reachable but names them as non-jumps", async () => {
    const onJump = vi.fn();
    renderRail({
      cells: [
        {
          ...emptyLanes(),
          r: [withoutRow(dotEvent("fail", "CI failed", 5))],
        },
      ],
      onJump,
    });

    const marker = screen.getByRole("button", { name: "Failures & limits" });
    expect(marker).toHaveAttribute("aria-disabled", "true");
    expect(marker).toHaveClass("no-jump");
    await userEvent.click(marker);
    expect(onJump).toHaveBeenCalledWith(null, true, "unresolvable");
  });

  /*
   * ISS-7632 (#5810 review, whitlockk): the dot going `aria-disabled` is only half
   * the promise. The hover card is the other half, and it used to close with
   * "click the dot to jump" unconditionally — so a withdrawn dot still invited
   * the click its own accessible name had just stopped offering.
   *
   * Driven through the REAL hover path rather than by handing the card a
   * hand-built prop: the rail's own `onHoverDot` payload selects the lane, and
   * the card is fed from the SAME `cells` the rail drew from, which is the only
   * way this asserts that the two agree rather than that both were told the
   * same thing twice.
   */
  it.each([
    {
      lane: [dotEvent("fail", "CI failed", 5)],
      name: "Jump to Failures & limits",
      offersJump: true,
      state: "anchored",
    },
    {
      lane: [withoutRow(dotEvent("fail", "CI failed", 5))],
      name: "Failures & limits",
      offersJump: false,
      state: "rowless",
    },
  ])(
    "$state: the hover card offers the jump only when the dot does",
    async ({ lane, name, offersJump }) => {
      const cells = [{ ...emptyLanes(), r: lane }];
      const onHoverDot = vi.fn();
      const { rerender } = render(
        <>
          {renderRailElement({ cells, onHoverDot, onJump: vi.fn() })}
          <SessionTimelineHoverCards {...hoverCardProps({ cells })} />
        </>
      );

      await userEvent.hover(screen.getByRole("button", { name }));

      const hoverDot = onHoverDot.mock.calls.at(-1)?.[0];
      expect(hoverDot).toMatchObject({ bucketIndex: 0, color: "r" });
      rerender(
        <>
          {renderRailElement({ cells, onHoverDot, onJump: vi.fn() })}
          <SessionTimelineHoverCards {...hoverCardProps({ cells, hoverDot })} />
        </>
      );

      // The card is up either way — the lane's events are still described.
      expect(screen.getByText("CI failed")).toBeInTheDocument();
      expect(screen.queryByText(CLICK_TO_JUMP_RE)).toStrictEqual(
        offersJump ? expect.anything() : null
      );
    }
  );
});

function hoverCardProps({
  cells,
  hoverDot = null,
}: {
  cells: Record<DotColor, Omit<ActivityMarker, "x">[]>[];
  hoverDot?: HoverDot | null;
}): Parameters<typeof SessionTimelineHoverCards>[0] {
  return {
    block: null,
    costsUnpublished: false,
    costUnmeasured: false,
    hoverBucket: null,
    hoverDot,
    hoveredBucket: null,
    hoveredEvents:
      hoverDot == null ? null : cells[hoverDot.bucketIndex]?.[hoverDot.color],
  };
}

function renderRail({
  cells,
  onJump,
}: {
  cells: Record<DotColor, Omit<ActivityMarker, "x">[]>[];
  onJump: Parameters<typeof SessionTimelineDotRail>[0]["onJump"];
}) {
  return render(renderRailElement({ cells, onHoverDot: vi.fn(), onJump }));
}

function renderRailElement({
  cells,
  onHoverDot,
  onJump,
}: {
  cells: Record<DotColor, Omit<ActivityMarker, "x">[]>[];
  onHoverDot: Parameters<typeof SessionTimelineDotRail>[0]["onHoverDot"];
  onJump: Parameters<typeof SessionTimelineDotRail>[0]["onJump"];
}) {
  return (
    <SessionTimelineDotRail
      buckets={stageBuckets(cells.length)}
      cells={cells}
      disabled={false}
      hoverDot={null}
      onHoverDot={onHoverDot}
      onJump={onJump}
    />
  );
}

function stageBuckets(count: number): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `${index * 5}m`,
    byModel: {},
    cCache: 0,
    cIn: 0,
    cOut: 0,
    key: `bucket-${index}`,
    tl0: index,
    toolStart: 0,
    total: 0,
  }));
}

function dotEvent(
  kind: ActivityMarker["kind"],
  label: string,
  row: number
): Omit<ActivityMarker, "x"> {
  return { kind, label, t: "9:05 AM", tl: row };
}

function withoutRow(
  event: Omit<ActivityMarker, "x">
): Omit<ActivityMarker, "x"> {
  const { tl: _row, ...rowless } = event;
  return rowless;
}

function emptyLanes(): Record<DotColor, Omit<ActivityMarker, "x">[]> {
  return { b: [], g: [], r: [] };
}
