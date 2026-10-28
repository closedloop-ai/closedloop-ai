import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ArtifactKind,
  type ArtifactSessionTrace,
  type ArtifactWritingSession,
  type GenericArtifact,
  genericArtifactSessionTrace,
  genericArtifacts,
} from "../../fixtures";
import { ArtifactSessionsTrace } from "../artifact-sessions-trace";
import { sessionRows } from "../experimental/session/mock";
import {
  buildSessionDetail,
  type SessionDetail,
} from "../experimental/session/mock-detail";
import type { SessionTimelineGrouping } from "../experimental/session/session-timeline-cells";

const IDLE_ROW_TEXT = /Idle between contributing sessions/;
const ITERATION_SUFFIX = /· iteration \d/;
const FIRST_TURN_TEXT = "Let's tackle: Establish the artifact structure";
const COSTS_TITLE = "Session Costs Over Time";
const TIMELINE_TITLE = /Over Time/;
const FIRST_BUCKET_LABEL = /^Jump to timeline bucket /;
const MORNING_START_BUCKET = /^Jump to timeline bucket 9:00 AM–9:15 AM/;
const LATE_START_BUCKET = /^Jump to timeline bucket 11:45 PM–12:00 AM/;

const [baseArtifact] = genericArtifacts;
const [firstSession] = genericArtifactSessionTrace.sessions;
const otherSessionRow = requireFixture(
  sessionRows.find((row) => row.id === "ses_8c7a")
);
if (!(baseArtifact && firstSession)) {
  throw new Error("preview fixtures are missing the rows this suite reads");
}

describe("ArtifactSessionsTrace aggregate trace", () => {
  it("repeats each writing session four times, separated by idle rows", () => {
    renderTrace();

    expect(
      screen.getByRole("tabpanel", { name: "FEA-2481 writing sessions" })
    ).toBeInTheDocument();
    expect(traceRows()).toHaveLength(95);
    const idleRows = traceRows().filter((row) =>
      IDLE_ROW_TEXT.test(row.textContent ?? "")
    );
    expect(idleRows).toHaveLength(11);
    expect(idleRows[0]).toHaveTextContent(
      "Idle between contributing sessions · started 07/18 10:35 AM · 1d 3h"
    );
    expect(idleRows[1]).toHaveTextContent(
      "Idle between contributing sessions · started 07/19 3:16 PM · 1d 3h"
    );
    expect(
      traceRows().map((row) => Number(row.dataset.traceRow))
    ).toStrictEqual(Array.from({ length: 95 }, (_, row) => row));
    expect(screen.getByText("84 turns · 153 tool calls")).toBeInTheDocument();
    expect(rowsContaining(FIRST_TURN_TEXT)).toHaveLength(4);
    expect(rowsContaining(`${FIRST_TURN_TEXT}.`)).toHaveLength(1);
    expect(rowsContaining(`${FIRST_TURN_TEXT} · iteration 1`)).toHaveLength(0);
    expect(
      traceRows().filter((row) => ITERATION_SUFFIX.test(row.textContent ?? ""))
        .length
    ).toBeGreaterThan(0);
    expect(
      rowsContaining(`${FIRST_TURN_TEXT} · iteration 2`).length
    ).toBeGreaterThan(0);
    expect(
      rowsContaining(`${FIRST_TURN_TEXT} · iteration 4`).length
    ).toBeGreaterThan(0);
  });

  it("stretches the aggregate to the simulated multi-day wall clock", () => {
    renderTrace();

    const header = timelineHeader();
    expect(header).toHaveTextContent(COSTS_TITLE);
    expect(header).toHaveTextContent("$145.24 cost");
    expect(header).toHaveTextContent("24,400,320 tokens");
    expect(header).toHaveTextContent("13d 0h");
    const rows = traceRows();
    expect(rows[0]).toHaveTextContent("07/18 9:02 AM");
    expect(rows.at(-1)).toHaveTextContent("07/31 9:02 AM");
  });

  it("labels turn avatars with the contributor of each writing session", () => {
    renderTrace();

    expect(screen.getAllByLabelText("Ottilie Eastwick").length).toBeGreaterThan(
      0
    );
    expect(screen.getAllByLabelText("Pascoe Birchall").length).toBeGreaterThan(
      0
    );
    expect(
      screen.getAllByLabelText("Agent for Jordan Lee").length
    ).toBeGreaterThan(0);
  });

  it("groups the cost chart by actor, one legend entry per contributor, unless told otherwise", () => {
    const { unmount } = renderTrace();
    const legend = screen.getByRole("list", { name: "Actor legend" });
    expect(legend).toBeVisible();
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toStrictEqual(["Ottilie Eastwick", "Pascoe Birchall", "Jordan Lee"]);
    unmount();

    renderTrace({ defaultGrouping: "model" });
    expect(screen.getByRole("list", { name: "Model legend" })).toBeVisible();
  });

  it("grows the wall clock past the simulated span when active time outruns it", () => {
    const longSessions = genericArtifactSessionTrace.sessions
      .slice(0, 2)
      .map((session) => ({ ...session, duration: "100h" }));
    renderTrace({
      trace: { ...genericArtifactSessionTrace, sessions: longSessions },
    });

    expect(timelineHeader()).toHaveTextContent("135d 0h");
    const [firstIdle] = traceRows().filter((row) =>
      IDLE_ROW_TEXT.test(row.textContent ?? "")
    );
    expect(firstIdle).toHaveTextContent("· 5d 0h");
  });

  it("titles the chart as definition contribution costs on an agent artifact", () => {
    renderTrace({ artifact: { ...baseArtifact, kind: ArtifactKind.Agent } });

    expect(
      screen.getByRole("heading", {
        name: "Definition Contribution Costs Over Time",
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: COSTS_TITLE })
    ).not.toBeInTheDocument();
  });
});

describe("ArtifactSessionsTrace single session", () => {
  it("never repeats a lone session or pads it with idle rows", () => {
    renderTrace({ trace: singleSessionTrace({ startAt: "11:50pm" }) });

    const rows = traceRows();
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => IDLE_ROW_TEXT.test(row.textContent ?? ""))).toBe(
      false
    );
    expect(
      rows.some((row) => ITERATION_SUFFIX.test(row.textContent ?? ""))
    ).toBe(false);
    expect(screen.getByText("3 turns · 6 tool calls")).toBeInTheDocument();
    const header = timelineHeader();
    expect(header).toHaveTextContent("$18.46 cost");
    expect(header).toHaveTextContent("3,101,280 tokens");
    expect(header).toHaveTextContent("2h 18m");
  });

  it("stamps a PM start and rolls the date past midnight", () => {
    renderTrace({ trace: singleSessionTrace({ startAt: "11:50pm" }) });

    const rows = traceRows();
    expect(rows[0]).toHaveTextContent("07/18 11:50 PM");
    expect(rows.at(-1)).toHaveTextContent("07/19 2:08 AM");
    expect(firstBucketLabel()).toBe(
      "Jump to timeline bucket 11:45 PM–12:00 AM, $13.17"
    );
    expect(screen.getByText("07/18 11:45 PM")).toBeInTheDocument();
  });

  it("reads an AM start as morning", () => {
    renderTrace({ trace: singleSessionTrace({}) });

    expect(traceRows()[0]).toHaveTextContent("07/18 9:02 AM");
    expect(firstBucketLabel()).toMatch(MORNING_START_BUCKET);
  });

  it("reads a noon start as twelve PM", () => {
    renderTrace({ trace: singleSessionTrace({ startAt: "12:30pm" }) });

    expect(traceRows()[0]).toHaveTextContent("07/18 12:30 PM");
  });

  it("zero-pads a single-digit day in the sent label", () => {
    renderTrace({ trace: singleSessionTrace({ startDate: "2026-07-05" }) });

    expect(traceRows()[0]).toHaveTextContent("07/05 9:02 AM");
  });

  it("keeps each agent turn's recorded duration", () => {
    renderTrace({ trace: singleSessionTrace({}) });

    const rows = traceRows();
    expect(rows[1]).toHaveTextContent("10m 51s");
    expect(rows[2]).toHaveTextContent("12m 24s");
  });

  it("shows the contributor's own initials on their turns", () => {
    renderTrace({
      trace: singleSessionTrace({}, { contributorInitials: "ZQ" }),
    });

    // One initial on every avatar (Nerys, 2026-10-22): the stored "ZQ" draws
    // "Z".
    expect(within(traceRowAt(0)).getByText("Z")).toBeVisible();
  });

  it("carries the session's timeline markers onto the chart", () => {
    renderTrace({ trace: singleSessionTrace({}) });

    expect(
      screen.getByRole("button", { name: "Jump to Human steering" })
    ).toBeInTheDocument();
  });

  it("reads a midnight start in any case as twelve AM", () => {
    renderTrace({ trace: singleSessionTrace({ startAt: "12:05 AM" }) });

    expect(traceRows()[0]).toHaveTextContent("07/18 12:05 AM");
  });

  it("falls back to elapsed labels and the session's own start on an unreadable clock", () => {
    renderTrace({ trace: singleSessionTrace({ startAt: "soon" }) });

    const rows = traceRows();
    expect(rows[0]).toHaveTextContent("0:00");
    expect(rows[1]).toHaveTextContent("0:02");
    expect(rows.at(-1)).toHaveTextContent("2:18");
    expect(firstBucketLabel()).toMatch(MORNING_START_BUCKET);
  });

  it.each(["July 18", "2026-07-18x", "x2026-07-18"])(
    "falls back to elapsed labels on the unreadable date %j but keeps the parsed start",
    (startDate) => {
      renderTrace({
        trace: singleSessionTrace({ startAt: "11:50pm", startDate }),
      });

      expect(traceRows()[0]).toHaveTextContent("0:00");
      expect(firstBucketLabel()).toMatch(LATE_START_BUCKET);
    }
  );

  it.each([
    ["", "45m", "0h 45m"],
    ["1.5h", "45m", "1h 30m"],
    ["30h", "45m", "1d 6h"],
    ["", "", "0h 1m"],
    ["24h", "45m", "1d 0h"],
    ["1.25h", "45m", "1h 15m"],
    ["", "10.25m", "0h 10m"],
  ])(
    "measures wall clock %j over a %j session as %s",
    (wallClock, duration, expected) => {
      renderTrace({
        trace: singleSessionTrace({ wallClock }, { duration }),
      });

      expect(timelineHeader()).toHaveTextContent(expected);
    }
  );

  it("drops the seconds from a session duration", () => {
    // pins current behavior; looks odd because "31m 18s" parses as 31 minutes
    renderTrace({
      trace: singleSessionTrace({ wallClock: "" }, { duration: "31m 18s" }),
    });

    expect(timelineHeader()).toHaveTextContent("0h 31m");
  });

  it("builds the trace from the session row matching the artifact when one exists", () => {
    const { unmount } = renderTrace({ trace: singleSessionTrace({}) });
    expect(traceRows()[0]).toHaveTextContent(
      "Match the existing patterns in closedloop-ai before writing anything."
    );
    unmount();

    renderTrace({
      artifact: { ...baseArtifact, id: otherSessionRow.id },
      trace: singleSessionTrace({}),
    });
    expect(traceRows()[0]).toHaveTextContent(
      "Match the existing patterns in closedloop-web before writing anything."
    );
  });
});

describe("ArtifactSessionsTrace without a derived trace", () => {
  it("renders nothing when there are no writing sessions", () => {
    renderTrace({ trace: { ...genericArtifactSessionTrace, sessions: [] } });

    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  });

  it("renders a supplied session detail even with no writing sessions", () => {
    const detail = overrideDetail();
    renderTrace({
      detailOverride: detail,
      trace: { ...genericArtifactSessionTrace, sessions: [] },
    });

    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
    expect(timelineHeader()).toHaveTextContent(`${detail.costLabel} cost`);
  });

  it("prefers a supplied session detail over the derived aggregate", () => {
    const detail = overrideDetail();
    renderTrace({ detailOverride: detail });

    expect(traceRows()).toHaveLength(detail.trace.length);
    expect(
      traceRows().some((row) => IDLE_ROW_TEXT.test(row.textContent ?? ""))
    ).toBe(false);
    expect(timelineHeader()).toHaveTextContent(`${detail.costLabel} cost`);
    expect(timelineHeader()).toHaveTextContent(detail.durationLabel);
  });
});

function renderTrace({
  artifact = baseArtifact,
  defaultGrouping,
  detailOverride,
  trace = genericArtifactSessionTrace,
}: {
  artifact?: GenericArtifact;
  defaultGrouping?: SessionTimelineGrouping;
  detailOverride?: SessionDetail;
  trace?: ArtifactSessionTrace;
} = {}) {
  return render(
    <ArtifactSessionsTrace
      artifact={artifact}
      commentAnchors={[]}
      defaultGrouping={defaultGrouping}
      detailOverride={detailOverride}
      onSubmitTraceComment={() => undefined}
      trace={trace}
      traceJumpRequest={null}
    />
  );
}

function singleSessionTrace(
  overrides: Partial<Omit<ArtifactSessionTrace, "sessions">>,
  sessionOverrides: Partial<ArtifactWritingSession> = {}
): ArtifactSessionTrace {
  return {
    ...genericArtifactSessionTrace,
    ...overrides,
    sessions: [{ ...firstSession, ...sessionOverrides }],
  };
}

function overrideDetail(): SessionDetail {
  return buildSessionDetail(otherSessionRow);
}

function traceRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-trace-row]")];
}

function traceRowAt(index: number): HTMLElement {
  const row = traceRows()[index];
  if (!row) {
    throw new Error(`trace row ${index} is not rendered`);
  }
  return row;
}

function rowsContaining(text: string): HTMLElement[] {
  return traceRows().filter((row) => row.textContent?.includes(text));
}

function timelineHeader(): HTMLElement {
  const heading = screen.getByRole("heading", {
    level: 2,
    name: TIMELINE_TITLE,
  });
  const header = heading.parentElement;
  if (!header) {
    throw new Error("timeline heading has no header row");
  }
  return header;
}

function firstBucketLabel(): string | null {
  const [bucket] = within(screen.getByRole("tabpanel")).getAllByRole("button", {
    name: FIRST_BUCKET_LABEL,
  });
  return bucket?.getAttribute("aria-label") ?? null;
}

function requireFixture<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("preview fixtures are missing the rows this suite reads");
  }
  return value;
}
