import type { BranchCommit } from "@repo/api/src/types/branch";
import type { BranchAssociatedPullRequest } from "@repo/api/src/types/branch-associated-pull-request";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { TimelineScale } from "@repo/app/agents/lib/session-timeline-scale";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchEventDotRail } from "../branch-event-dot-rail";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const TWO_MORE_RE = /2 more timeline events/i;
const ANY_MORE_RE = /more timeline events/i;
const JUMP_TO_COMMIT_RE = /^Jump to Commit/;
const SAME_TIME = "2026-06-10T10:00:00.000Z";

function ev(dot: "g" | "b" | "r", text: string, t: string): MergedTraceItem {
  return { type: "event", sessionId: "s1", t, dot, text };
}

function commit(overrides: Partial<BranchCommit> = {}): BranchCommit {
  return {
    sha: "abcdef1234567890",
    committedAt: SAME_TIME,
    message: "Fix the parser",
    ...overrides,
  };
}

function pullRequest(
  overrides: Partial<BranchAssociatedPullRequest> = {}
): BranchAssociatedPullRequest {
  return {
    closedAt: null,
    id: "repo#9",
    isDraft: false,
    mergedAt: null,
    number: 9,
    openedAt: null,
    repositoryFullName: "acme/repo",
    reviewDecision: null,
    state: GitHubPRState.Open,
    title: "Open",
    url: null,
    ...overrides,
  };
}

function railDots(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".bq-dot"));
}

describe("BranchEventDotRail lifecycle dots", () => {
  it("labels commits by subject, falls back to the short SHA, and skips unparseable commit times", () => {
    render(
      <BranchEventDotRail
        commits={[
          commit({ committedAt: "2026-06-10T09:00:00.000Z" }),
          commit({ committedAt: "2026-06-10T11:00:00.000Z", message: "" }),
          commit({ committedAt: "not-a-time", message: "Lost commit" }),
        ]}
        onScrub={vi.fn()}
        traceItems={[]}
      />
    );
    expect(
      screen.getByRole("button", { name: "Fix the parser" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "abcdef1" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Lost commit" })
    ).not.toBeInTheDocument();
    expect(railDots()).toHaveLength(2);
  });

  it("labels legacy opened and merged dots without a PR number when none is known", () => {
    render(
      <BranchEventDotRail
        mergedAt="2026-06-10T12:00:00.000Z"
        onScrub={vi.fn()}
        openedAt="2026-06-10T08:00:00.000Z"
        traceItems={[]}
      />
    );
    expect(screen.getByRole("button", { name: "Opened" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Merged" })).toBeVisible();
  });

  it("skips unparseable legacy opened and merged times", () => {
    render(
      <BranchEventDotRail
        mergedAt="garbage"
        onScrub={vi.fn()}
        openedAt="garbage"
        prNumber={3}
        traceItems={[]}
      />
    );
    expect(railDots()).toHaveLength(0);
  });

  it("uses associated PR history instead of the legacy opened and merged props", () => {
    render(
      <BranchEventDotRail
        mergedAt="2026-06-10T12:00:00.000Z"
        onScrub={vi.fn()}
        openedAt="2026-06-10T08:00:00.000Z"
        prNumber={3}
        pullRequests={[pullRequest({ openedAt: "2026-06-10T09:00:00.000Z" })]}
        traceItems={[]}
      />
    );
    expect(screen.getByRole("button", { name: "Opened #9" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Opened #3" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Merged #3" })
    ).not.toBeInTheDocument();
    expect(railDots()).toHaveLength(1);
  });

  it("emits no dots for a PR whose opened and closed times are unparseable", () => {
    render(
      <BranchEventDotRail
        onScrub={vi.fn()}
        pullRequests={[pullRequest({ openedAt: "bad", closedAt: "bad" })]}
        traceItems={[]}
      />
    );
    expect(railDots()).toHaveLength(0);
  });

  it("describes a lifecycle dot's provenance in its tooltip", () => {
    render(
      <BranchEventDotRail
        mergedAt="2026-06-10T12:00:00.000Z"
        prNumber={5}
        traceItems={[]}
      />
    );
    expect(screen.getByText("Lifecycle event")).toBeInTheDocument();
    expect(screen.getByText("Commits & PRs")).toBeInTheDocument();
  });
});

describe("BranchEventDotRail clusters", () => {
  const overflowTrace = [
    ev("b", "First", SAME_TIME),
    ev("b", "Second", SAME_TIME),
    ev("g", "Third", SAME_TIME),
    ev("r", "Fourth", SAME_TIME),
  ];

  it("renders a static cluster with a tooltip listing its members when the rail cannot scrub", () => {
    render(<BranchEventDotRail traceItems={overflowTrace} />);
    expect(
      screen.queryByRole("button", { name: TWO_MORE_RE })
    ).not.toBeInTheDocument();
    const cluster = document.querySelector<HTMLElement>(".bq-dot-cluster");
    expect(cluster?.className).not.toContain("hot");
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("marks an interactive cluster hot when it holds the active row", () => {
    render(
      <BranchEventDotRail
        activeRow={1}
        onScrub={vi.fn()}
        traceItems={overflowTrace}
      />
    );
    const trigger = screen.getByRole("button", { name: TWO_MORE_RE });
    expect(trigger.className).toContain("hot");
    expect(
      document.querySelector<HTMLElement>(".bq-dot-cluster")?.className
    ).toContain("hot");
  });

  it("leaves an interactive cluster cold when the active row is elsewhere", () => {
    render(
      <BranchEventDotRail
        activeRow={3}
        onScrub={vi.fn()}
        traceItems={overflowTrace}
      />
    );
    expect(
      screen.getByRole("button", { name: TWO_MORE_RE }).className
    ).not.toContain("hot");
  });

  it("jumps a lifecycle cluster member by timestamp", async () => {
    const onScrub = vi.fn();
    const onScrubRow = vi.fn();
    render(
      <BranchEventDotRail
        commits={[
          commit({ message: "Commit A", sha: "aaaaaaa1" }),
          commit({ message: "Commit B", sha: "bbbbbbb1" }),
          commit({ message: "Commit C", sha: "ccccccc1" }),
          commit({ message: "Commit D", sha: "ddddddd1" }),
        ]}
        onScrub={onScrub}
        onScrubRow={onScrubRow}
        traceItems={[]}
      />
    );
    const cluster = screen.getAllByRole("button", {
      name: ANY_MORE_RE,
    })[0];
    await userEvent.click(cluster as HTMLElement);
    const jump = screen.getAllByRole("button", { name: JUMP_TO_COMMIT_RE })[0];
    await userEvent.click(jump as HTMLElement);
    expect(onScrubRow).not.toHaveBeenCalled();
    expect(onScrub).toHaveBeenCalledWith(SAME_TIME);
  });
});

describe("BranchEventDotRail axis", () => {
  it("draws no dots when column alignment is requested without a grid", () => {
    render(
      <BranchEventDotRail
        alignToTimelineColumns
        traceItems={[ev("g", "Push", SAME_TIME)]}
      />
    );
    expect(railDots()).toHaveLength(0);
  });

  it("drops a trace event with an unparseable time from an active-column rail", () => {
    render(
      <BranchEventDotRail
        activeColumnGrid={{
          originMs: Date.parse(SAME_TIME),
          scale: TimelineScale.OneHour,
        }}
        activeHourStarts={[SAME_TIME]}
        alignToTimelineColumns
        traceItems={[
          ev("g", "Kept", "2026-06-10T10:10:00.000Z"),
          ev("r", "Broken", "not-a-time"),
        ]}
      />
    );
    expect(railDots()).toHaveLength(1);
    expect(screen.queryByText("Broken")).not.toBeInTheDocument();
  });

  it("drops a trace event with an unparseable time from an unaligned rail", () => {
    render(
      <BranchEventDotRail
        traceItems={[
          ev("g", "Kept", SAME_TIME),
          ev("r", "Broken", "not-a-time"),
        ]}
      />
    );
    expect(railDots()).toHaveLength(1);
    expect(screen.queryByText("Broken")).not.toBeInTheDocument();
  });

  it("drops an unparseable trace time from a column-aligned rail with no active-bar filter", () => {
    render(
      <BranchEventDotRail
        activeColumnGrid={{
          originMs: Date.parse(SAME_TIME),
          scale: TimelineScale.OneHour,
        }}
        alignToTimelineColumns
        traceItems={[
          ev("g", "Kept", "2026-06-10T10:10:00.000Z"),
          ev("r", "Broken", "not-a-time"),
        ]}
      />
    );
    expect(railDots()).toHaveLength(1);
  });

  it("positions dots on a caller-supplied axis instead of deriving one", () => {
    const startMs = Date.parse(SAME_TIME);
    render(
      <BranchEventDotRail
        range={{ startMs, endMs: startMs + 4_000_000, spanMs: 4_000_000 }}
        traceItems={[ev("g", "Push", "2026-06-10T10:16:40.000Z")]}
      />
    );
    const marker = document.querySelector<HTMLElement>(".bq-marker-trigger");
    expect(marker?.style.left).toBe("25%");
  });

  it("ignores trace items that are not events", () => {
    render(
      <BranchEventDotRail
        traceItems={[
          { type: "end", sessionId: "s1", text: "done" },
          ev("b", "Steer", SAME_TIME),
        ]}
      />
    );
    expect(railDots()).toHaveLength(1);
  });
});
