import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { buildActorColorDomain } from "../../lib/branch-actor-domain";
import { BranchPrSessionSwimlane } from "../branch-pr-session-swimlane";

const NO_SESSIONS_RE = /no sessions linked/i;

function say(sessionId: string, t: string): MergedTraceItem {
  return {
    type: "say",
    sessionId,
    t,
    tMs: 0,
    cumCostUsd: null,
    actorName: null,
    text: "x",
  };
}

function start(
  sessionId: string,
  t: string,
  name: string | null,
  ci = false
): MergedTraceItem {
  return {
    type: "sessionstart",
    sessionId,
    t,
    actor: { name, harness: null, ci },
  };
}

// s1 = alice (idle gap → resumption); s2 = CI; ordered by start time.
const mergedTrace: MergedTraceItem[] = [
  start("s1", "2026-06-10T10:00:00.000Z", "alice"),
  say("s1", "2026-06-10T10:00:00.000Z"),
  say("s1", "2026-06-10T10:40:00.000Z"),
  start("s2", "2026-06-10T10:30:00.000Z", null, true),
  say("s2", "2026-06-10T10:30:00.000Z"),
];

function detail() {
  return makeBranchDetail({
    sessions: [
      makeBranchSession({
        sessionId: "s1",
        harness: "claude",
        startedAt: "2026-06-10T10:00:00.000Z",
        endedAt: "2026-06-10T11:00:00.000Z",
      }),
      makeBranchSession({
        sessionId: "s2",
        harness: "ci",
        startedAt: "2026-06-10T10:30:00.000Z",
        endedAt: "2026-06-10T10:45:00.000Z",
      }),
    ],
    mergedTrace,
  });
}

function lanes(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".bq-lane"));
}

describe("BranchPrSessionSwimlane (E4)", () => {
  it("renders one lane per session ordered by start with CI and resumed badges", () => {
    const { container } = render(<BranchPrSessionSwimlane detail={detail()} />);
    const names = Array.from(container.querySelectorAll(".bq-lane-name")).map(
      (el) => el.textContent
    );
    expect(names).toEqual(["alice", "ci"]);
    expect(screen.getByText("CI")).toBeInTheDocument();
    expect(screen.getByText("resumed")).toBeInTheDocument();
  });

  it("does not render idle/gap elements (idle is implicit — V2)", () => {
    const { container } = render(<BranchPrSessionSwimlane detail={detail()} />);
    expect(container.querySelector("[data-idle], [data-gap]")).toBeNull();
  });

  it("renders a single lane with no concurrency chrome for a one-session branch", () => {
    const single = makeBranchDetail({
      sessions: [makeBranchSession({ sessionId: "s1", harness: "claude" })],
      mergedTrace: [start("s1", "2026-06-10T10:00:00.000Z", "alice")],
    });
    const { container } = render(<BranchPrSessionSwimlane detail={single} />);
    expect(lanes(container)).toHaveLength(1);
    expect(screen.queryByText("CI")).not.toBeInTheDocument();
  });

  it("colors lanes from an injected domain so they match an E1 instance", () => {
    const domain = buildActorColorDomain(["alice", "ci"]);
    const { container } = render(
      <BranchPrSessionSwimlane actorDomain={domain} detail={detail()} />
    );
    const [aliceLane] = lanes(container);
    const seg = aliceLane?.querySelector<HTMLElement>(".bq-lane-seg");
    expect(seg?.style.background).toBe(domain.colorFor("alice"));
  });

  it("renders the empty state with no sessions", () => {
    render(
      <BranchPrSessionSwimlane detail={makeBranchDetail({ sessions: [] })} />
    );
    expect(screen.getByText(NO_SESSIONS_RE)).toBeInTheDocument();
  });

  it("positions the playhead on the injected shared range, not its internal axis", () => {
    // The internal session-extent axis is 10:00–11:00 (→ 10:30 ≈ 50%). Injecting
    // the wider page range 10:00–12:00 must drive positioning instead (→ 25%),
    // so the swimlane lines up with the E1 timeline/playhead above it.
    const start = Date.parse("2026-06-10T10:00:00.000Z");
    const end = Date.parse("2026-06-10T12:00:00.000Z");
    const { container } = render(
      <BranchPrSessionSwimlane
        activeTimestamp="2026-06-10T10:30:00.000Z"
        detail={detail()}
        range={{ startMs: start, endMs: end, spanMs: end - start }}
      />
    );
    expect(
      container.querySelector<HTMLElement>(".bq-lane-playhead")?.style.left
    ).toBe("25%");
  });

  it("draws a playhead and scrubs the trace on burst click", async () => {
    const onScrubTimestamp = vi.fn();
    const { container } = render(
      <BranchPrSessionSwimlane
        activeTimestamp="2026-06-10T10:30:00.000Z"
        detail={detail()}
        onScrubTimestamp={onScrubTimestamp}
      />
    );
    expect(container.querySelector(".bq-lane-playhead")).not.toBeNull();
    const seg = container.querySelector<HTMLElement>(".bq-lane-seg");
    await userEvent.click(seg as HTMLElement);
    expect(onScrubTimestamp).toHaveBeenCalled();
  });
});
