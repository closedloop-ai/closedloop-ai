import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchEventDotRail } from "../branch-event-dot-rail";

const CONNECT_GITHUB_RE = /connect github/i;

function ev(dot: "g" | "b" | "r", text: string, t: string): MergedTraceItem {
  return { type: "event", sessionId: "s1", t, dot, text };
}

const traceItems: MergedTraceItem[] = [
  ev("g", "Commit pushed", "2026-06-10T10:00:00.000Z"),
  ev("r", "CI failed", "2026-06-10T11:00:00.000Z"),
  ev("b", "autonomy step", "2026-06-10T11:30:00.000Z"),
];

function dots(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".bq-dot"));
}

describe("BranchEventDotRail (E3)", () => {
  it("maps typed steering, GitHub, and failure events to exact blue, green, and red dots", () => {
    const { container } = render(
      <BranchEventDotRail githubConnected={false} traceItems={traceItems} />
    );
    expect(dots(container)).toHaveLength(3);
    expect(container.querySelectorAll(".bq-dot.d-blue")).toHaveLength(1);
    expect(container.querySelectorAll(".bq-dot.d-green")).toHaveLength(1);
    expect(container.querySelectorAll(".bq-dot.d-red")).toHaveLength(1);
    expect(container.querySelector(".bq-dot.d-orange")).toBeNull();
    expect(screen.queryByText(CONNECT_GITHUB_RE)).not.toBeInTheDocument();
  });

  it("keeps typed blue authoritative even when steering copy mentions a PR", () => {
    const { container } = render(
      <BranchEventDotRail
        traceItems={[
          ev("b", "Steer the PR review", "2026-06-10T10:00:00.000Z"),
        ]}
      />
    );
    expect(container.querySelector(".bq-dot.d-blue")).not.toBeNull();
    expect(container.querySelector(".bq-dot.d-green")).toBeNull();
  });

  it("filters events to active bars and stacks events in the same hour", () => {
    const { container } = render(
      <BranchEventDotRail
        activeHourStarts={["2026-06-10T10:00:00.000Z"]}
        traceItems={[
          ev("b", "Steering", "2026-06-10T10:05:00.000Z"),
          ev("g", "Push", "2026-06-10T10:15:00.000Z"),
          ev("r", "Limit", "2026-06-10T11:00:00.000Z"),
        ]}
      />
    );
    const renderedDots = dots(container);
    expect(renderedDots).toHaveLength(2);
    expect(renderedDots.map((dot) => dot.style.top)).toEqual(["3px", "37px"]);
  });

  it("scrubs to a dot's timestamp on click and highlights the active row", async () => {
    const onScrub = vi.fn();
    const { container } = render(
      <BranchEventDotRail
        activeRow={0}
        githubConnected
        onScrub={onScrub}
        traceItems={traceItems}
      />
    );
    const greenDot = container.querySelector<HTMLElement>(".bq-dot.d-green");
    expect(greenDot?.className).toContain("hot");
    await userEvent.click(greenDot as HTMLElement);
    // The green dot is the commit event at 10:00 — scrubbing by timestamp lets
    // the shared controller derive the nearest row AND scroll the trace.
    expect(onScrub).toHaveBeenCalledWith("2026-06-10T10:00:00.000Z");
  });

  it("uses the exact stored row when stacked events share a timestamp", async () => {
    const onScrubRow = vi.fn();
    render(
      <BranchEventDotRail
        onScrub={vi.fn()}
        onScrubRow={onScrubRow}
        traceItems={[
          ev("b", "First", "2026-06-10T10:00:00.000Z"),
          ev("r", "Second", "2026-06-10T10:00:00.000Z"),
        ]}
      />
    );
    const second = screen.getByRole("button", { name: "Second" });
    expect(second.className).toContain("size-8");
    expect(second.className).toContain("focus-visible:ring-2");
    await userEvent.click(second);
    expect(onScrubRow).toHaveBeenCalledWith(1);
  });

  it("renders a green merge lifecycle dot from mergedAt and scrubs to its time on click", async () => {
    const onScrub = vi.fn();
    render(
      <BranchEventDotRail
        githubConnected
        mergedAt="2026-06-10T12:00:00.000Z"
        onScrub={onScrub}
        prNumber={42}
        traceItems={[]}
      />
    );
    // No trace events, just the lifecycle merge dot — clickable via its timestamp.
    const merge = screen.getByRole("button", { name: "Merged #42" });
    await userEvent.click(merge);
    expect(onScrub).toHaveBeenCalledWith("2026-06-10T12:00:00.000Z");
  });

  it("renders lifecycle events for every associated PR including closed-unmerged outcomes", () => {
    render(
      <BranchEventDotRail
        activeHourStarts={["2026-06-12T10:00:00.000Z"]}
        onScrub={vi.fn()}
        pullRequests={[
          {
            closedAt: null,
            id: "repo#1",
            isDraft: false,
            mergedAt: "2026-06-10T12:00:00.000Z",
            number: 1,
            openedAt: "2026-06-10T09:00:00.000Z",
            repositoryFullName: "acme/repo",
            reviewDecision: null,
            state: GitHubPRState.Merged,
            title: "Merged",
            url: null,
          },
          {
            closedAt: "2026-06-11T12:00:00.000Z",
            id: "repo#2",
            isDraft: false,
            mergedAt: null,
            number: 2,
            openedAt: "2026-06-11T09:00:00.000Z",
            repositoryFullName: "acme/repo",
            reviewDecision: null,
            state: GitHubPRState.Closed,
            title: "Closed",
            url: null,
          },
        ]}
        traceItems={[]}
      />
    );

    expect(screen.getByRole("button", { name: "Opened #1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Merged #1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Opened #2" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Closed #2" })).toBeVisible();
  });
});
