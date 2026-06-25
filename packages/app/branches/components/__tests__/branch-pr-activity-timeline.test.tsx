import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { BranchPrActivityTimeline } from "../branch-pr-activity-timeline";

const SESSIONS_RE = /2 sessions/;
const NO_ACTIVITY_RE = /no session activity/i;

function startItem(
  sessionId: string,
  t: string,
  name: string | null
): MergedTraceItem {
  return { type: "sessionstart", sessionId, t, actor: { name, harness: null } };
}

function bars(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".bq-bar"));
}

describe("BranchPrActivityTimeline (E1, sessions-driven)", () => {
  it("renders one bar per clock-hour with gaps, plus a session-count header", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          inputTokens: 100,
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T13:00:00.000Z",
          endedAt: "2026-06-10T14:00:00.000Z",
          inputTokens: 50,
        }),
      ],
    });
    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    // Hours 10, 11, 12, 13 → 4 columns; 11 and 12 are synthesized gaps.
    expect(bars(container)).toHaveLength(4);
    expect(container.querySelectorAll('.bq-bar[data-gap="true"]')).toHaveLength(
      2
    );
    expect(screen.getByText(SESSIONS_RE)).toBeInTheDocument();
  });

  it("renders a single color when every session shares one actor", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          inputTokens: 100,
        }),
      ],
    });
    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    const keys = new Set(
      Array.from(container.querySelectorAll("[data-actor-key]")).map((el) =>
        el.getAttribute("data-actor-key")
      )
    );
    expect(keys.size).toBe(1);
  });

  it("concurrency-marks an hour with two distinct actors", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          inputTokens: 100,
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          inputTokens: 80,
        }),
      ],
      mergedTrace: [
        startItem("s1", "2026-06-10T10:00:00.000Z", "alice"),
        startItem("s2", "2026-06-10T10:00:00.000Z", "bob"),
      ],
    });
    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    const concurrent = container.querySelector(
      '.bq-bar[data-concurrent="true"]'
    );
    expect(concurrent).not.toBeNull();
    expect(concurrent?.querySelectorAll("[data-actor-key]")).toHaveLength(2);
  });

  it("renders the empty state when there are no sessions", () => {
    render(
      <BranchPrActivityTimeline detail={makeBranchDetail({ sessions: [] })} />
    );
    expect(screen.getByText(NO_ACTIVITY_RE)).toBeInTheDocument();
  });

  it("fires onScrubHour with the bar's hour and highlights the active bar", async () => {
    const onScrubHour = vi.fn();
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          inputTokens: 100,
        }),
      ],
    });
    const { container } = render(
      <BranchPrActivityTimeline
        activeHourStart="2026-06-10T10:00:00.000Z"
        detail={detail}
        onScrubHour={onScrubHour}
      />
    );
    const [bar] = bars(container);
    expect(bar?.className).toContain("hot");
    await userEvent.click(bar as HTMLElement);
    expect(onScrubHour).toHaveBeenCalledWith("2026-06-10T10:00:00.000Z");
  });
});
