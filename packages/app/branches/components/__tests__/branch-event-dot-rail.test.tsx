import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { TimelineScale } from "@repo/app/agents/lib/session-timeline-scale";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BranchEventDotRail } from "../branch-event-dot-rail";

const CONNECT_GITHUB_RE = /connect (?:to )?github/i;
const TWO_MORE_TIMELINE_EVENTS_RE = /2 more timeline events/i;

/**
 * ISS-8771: the rail is told WHICH grid the active bars were cut on, rather than
 * a column width it would re-floor against the epoch.
 */
const ONE_HOUR_GRID_AT_TEN = {
  originMs: Date.parse("2026-06-10T10:00:00.000Z"),
  scale: TimelineScale.OneHour,
} as const;

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

function markerTriggers(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".bq-marker-trigger")
  );
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

  it("filters events to active bars and centers visible dots in their active column", () => {
    const { container } = render(
      <BranchEventDotRail
        activeColumnGrid={ONE_HOUR_GRID_AT_TEN}
        activeHourStarts={["2026-06-10T10:00:00.000Z"]}
        alignToTimelineColumns
        traceItems={[
          ev("b", "Steering", "2026-06-10T10:05:00.000Z"),
          ev("g", "Push", "2026-06-10T10:15:00.000Z"),
          ev("r", "Limit", "2026-06-10T11:00:00.000Z"),
        ]}
      />
    );
    const renderedDots = dots(container);
    expect(renderedDots).toHaveLength(2);
    expect(
      markerTriggers(container).map((marker) => marker.style.left)
    ).toEqual(["50%", "50%"]);
    expect(markerTriggers(container).map((marker) => marker.style.top)).toEqual(
      ["0px", "24px"]
    );
    expect(
      container.querySelector<HTMLElement>("[data-timeline-marker-rail]")?.style
        .height
    ).toBe("48px");
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

  it("clusters same-category same-timestamp events and keeps exact stored row jumps", async () => {
    const onScrubRow = vi.fn();
    render(
      <BranchEventDotRail
        onScrub={vi.fn()}
        onScrubRow={onScrubRow}
        traceItems={[
          ev("b", "First", "2026-06-10T10:00:00.000Z"),
          ev("b", "Second", "2026-06-10T10:00:00.000Z"),
        ]}
      />
    );
    const cluster = screen.getByRole("button", {
      name: TWO_MORE_TIMELINE_EVENTS_RE,
    });
    expect(cluster.className).toContain("bq-marker-trigger");
    expect(cluster.style.top).toBe("0px");
    await userEvent.click(cluster);
    await userEvent.click(
      screen.getByRole("button", { name: "Jump to Second" })
    );
    expect(onScrubRow).toHaveBeenCalledWith(1, true);
  });

  it("separates same-column different categories into semantic rows", () => {
    const { container } = render(
      <BranchEventDotRail
        onScrub={vi.fn()}
        traceItems={[
          ev("b", "Steer", "2026-06-10T10:00:00.000Z"),
          ev("g", "Commit", "2026-06-10T10:00:00.000Z"),
          ev("r", "Error", "2026-06-10T10:00:00.000Z"),
        ]}
      />
    );

    expect(markerTriggers(container).map((marker) => marker.style.top)).toEqual(
      ["0px", "24px", "48px"]
    );
    expect(
      container.querySelector<HTMLElement>("[data-timeline-marker-rail]")?.style
        .height
    ).toBe("72px");
  });

  it("centers same scaled-column events under the same bar", () => {
    // ISS-8771: instants built on the LOCAL clock and an origin on the local
    // half-day, because a `12h` column is now a local half-day rather than a
    // fixed slice of the epoch. Same three-in-one-column case as before, stated
    // so it means the same thing in every zone rather than only in UTC.
    const columnStart = new Date(2026, 5, 10, 12, 0, 0, 0);
    const atHour = (hours: number) =>
      new Date(columnStart.getTime() + hours * 3_600_000).toISOString();
    const { container } = render(
      <BranchEventDotRail
        activeColumnGrid={{
          originMs: columnStart.getTime(),
          scale: TimelineScale.TwelveHours,
        }}
        alignToTimelineColumns
        traceItems={[
          ev("b", "Steer", atHour(1)),
          ev("g", "Commit", atHour(4)),
          ev("r", "Error", atHour(9)),
        ]}
      />
    );

    const markers = markerTriggers(container);
    expect(markers.map((marker) => marker.style.left)).toEqual([
      "50%",
      "50%",
      "50%",
    ]);
    expect(markers.map((marker) => marker.style.top)).toEqual([
      "0px",
      "24px",
      "48px",
    ]);
  });

  it("clusters collision overflow while keeping every member jumpable", async () => {
    const onScrubRow = vi.fn();
    const { container } = render(
      <BranchEventDotRail
        onScrub={vi.fn()}
        onScrubRow={onScrubRow}
        traceItems={[
          ev("b", "First", "2026-06-10T10:00:00.000Z"),
          ev("b", "Second", "2026-06-10T10:00:00.000Z"),
          ev("g", "Third", "2026-06-10T10:00:00.000Z"),
          ev("r", "Fourth", "2026-06-10T10:00:00.000Z"),
        ]}
      />
    );

    expect(
      screen.queryByRole("button", { name: "First" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Second" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Third" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Fourth" })).toBeVisible();

    const cluster = screen.getByRole("button", {
      name: TWO_MORE_TIMELINE_EVENTS_RE,
    });
    expect(cluster).toBeVisible();
    expect(cluster.style.top).toBe("0px");
    expect(screen.getByRole("button", { name: "Third" }).style.top).toBe(
      "24px"
    );
    expect(screen.getByRole("button", { name: "Fourth" }).style.top).toBe(
      "48px"
    );
    expect(
      container.querySelector<HTMLElement>("[data-timeline-marker-rail]")?.style
        .height
    ).toBe("72px");
    await userEvent.click(cluster);
    expect(screen.getAllByText("Human steering")).toHaveLength(2);
    expect(screen.getByText("Trace row 1")).toBeVisible();
    expect(screen.getByText("Trace row 2")).toBeVisible();
    expect(screen.getByText("First")).toBeVisible();
    expect(screen.getByText("Second")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Fourth" }));
    expect(onScrubRow).toHaveBeenCalledWith(3, true);
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

/**
 * ISS-8771 — the rail and the bars must be cut on ONE grid.
 *
 * The rail used to re-floor each dot with `Math.floor(t / columnMs) * columnMs`
 * and string-compare the result against the bars' `hourStart`. That agreed only
 * while the bars were floored the same way, i.e. on the epoch. Once the bars
 * moved onto the viewer's clock, the two keys could never match for an off-UTC
 * viewer and EVERY trace dot was silently filtered out — the rail still drew,
 * because lifecycle dots do not filter, so nothing looked broken.
 *
 * Asia/Kolkata (+05:30) is the discriminator: at `12h` its local half-days are
 * 18:30Z and 06:30Z, which no UTC 12h boundary ever equals. In UTC — which is
 * what CI runs — the two grids coincide and this case cannot fail.
 */
describe("BranchEventDotRail column grid (ISS-8771)", () => {
  const originalTimezone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "Asia/Kolkata";
  });

  afterAll(() => {
    if (originalTimezone === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
      return;
    }
    process.env.TZ = originalTimezone;
  });

  it("keeps a trace dot visible when the bars are cut on the viewer's clock", () => {
    // Local noon in +05:30 is 06:30Z. The bar starts there; the dot lands inside
    // it; the epoch floor would key that dot to 00:00Z and drop it.
    const columnStart = new Date(2026, 5, 10, 12, 0, 0, 0);
    const insideColumn = new Date(columnStart.getTime() + 3_600_000);
    const { container } = render(
      <BranchEventDotRail
        activeColumnGrid={{
          originMs: columnStart.getTime(),
          scale: TimelineScale.TwelveHours,
        }}
        activeHourStarts={[columnStart.toISOString()]}
        alignToTimelineColumns
        traceItems={[ev("g", "Push", insideColumn.toISOString())]}
      />
    );

    expect(dots(container)).toHaveLength(1);
  });

  it("still drops a trace dot that falls in a column no bar covers", () => {
    // The positive sibling's opposite: same grid, an instant a full half-day
    // later, so "the dot survived" cannot be "filtering stopped working".
    const columnStart = new Date(2026, 5, 10, 12, 0, 0, 0);
    const nextColumn = new Date(2026, 5, 11, 0, 0, 0, 0);
    const { container } = render(
      <BranchEventDotRail
        activeColumnGrid={{
          originMs: columnStart.getTime(),
          scale: TimelineScale.TwelveHours,
        }}
        activeHourStarts={[columnStart.toISOString()]}
        alignToTimelineColumns
        traceItems={[
          ev(
            "g",
            "Push",
            new Date(nextColumn.getTime() + 60_000).toISOString()
          ),
        ]}
      />
    );

    expect(dots(container)).toHaveLength(0);
  });
});
