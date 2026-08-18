import {
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { SESSION_REPOSITORY_MALFORMED_TOOLTIP } from "@repo/app/agents/lib/session-repository-label";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_DURATION_TICK_MS } from "../../../lib/session-duration";
import { createAgentSessionListItemFixture } from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";
import {
  GRID_EMPTY_VALUE_TEXT_REGEX,
  getGridCellForSessionName,
  getRepoCellForSessionName,
  REPOSITORY_MALFORMED_TEXT_REGEX,
  renderWithFlags,
} from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

// SES-78262: 63.1 hours since last activity, still rendering "Active" against a
// 24-hour reaper cutoff.
const NOW = new Date("2026-08-03T12:00:00.000Z");
const STALE_63H = new Date("2026-08-01T00:54:00.000Z");
const FRESH = new Date("2026-08-03T11:00:00.000Z");

function getStatusCell(sessionName: string): HTMLElement {
  return getGridCellForSessionName(sessionName, "Status");
}

describe("SyncedSessionsTable — ISS-4997/4998 honest status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const staleActive = createAgentSessionListItemFixture({
    id: "stale-active",
    name: "Stale active session",
    status: SESSION_STATUS.ACTIVE,
    lastActivityAt: STALE_63H,
    endedAt: null,
  });

  const versionSkewed = createAgentSessionListItemFixture({
    id: "version-skewed",
    name: "Version skewed session",
    status: "some_future_state",
    lastActivityAt: FRESH,
    endedAt: null,
  });

  const liveActive = createAgentSessionListItemFixture({
    id: "live-active",
    name: "Live active session",
    status: SESSION_STATUS.ACTIVE,
    lastActivityAt: FRESH,
    endedAt: null,
  });

  it("ISS-4998: a session silent for 63 hours does not render Active", () => {
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[staleActive]}
      />
    );

    const statusCell = getStatusCell("Stale active session");
    // #4324 review: a silent run reads "Stale", NOT "Unknown" — the two are
    // different facts and only this one is actionable.
    expect(statusCell).toHaveTextContent("Stale");
    expect(statusCell).not.toHaveTextContent("Active");
  });

  it("ISS-4997: an unrecognized status does not render Active", () => {
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[versionSkewed]}
      />
    );

    const statusCell = getStatusCell("Version skewed session");
    expect(statusCell).toHaveTextContent("Unknown");
    expect(statusCell).not.toHaveTextContent("Active");
  });

  it("leaves a genuinely-live session reading Active", () => {
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[liveActive]}
      />
    );

    expect(getStatusCell("Live active session")).toHaveTextContent("Active");
  });

  it("re-evaluates staleness on its own clock, without an items change", async () => {
    // ISS-4998: the fold reads the CURRENT time, but the row mapping is memoized
    // on `items` — and TanStack's structural sharing keeps that array
    // referentially stable across refetches that return an unchanged page. During
    // an idle window (exactly when a session is going quiet) nothing would
    // invalidate the memo, so a row that crossed the cutoff while on screen would
    // keep claiming "Active". Mount just inside the threshold, advance the clock
    // past it WITHOUT touching `items`, and the badge must correct itself.
    const justInsideCutoff = new Date(
      NOW.getTime() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS * 60 - 2) * 60_000
    );
    const aboutToGoStale = createAgentSessionListItemFixture({
      id: "about-to-go-stale",
      name: "About to go stale",
      status: SESSION_STATUS.ACTIVE,
      lastActivityAt: justInsideCutoff,
      endedAt: null,
    });
    const items = [aboutToGoStale];

    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={items}
      />
    );

    expect(getStatusCell("About to go stale")).toHaveTextContent("Active");

    // Cross the threshold with the SAME items array identity.
    await act(async () => {
      vi.setSystemTime(new Date(NOW.getTime() + 4 * 60_000));
      await vi.advanceTimersByTimeAsync(SESSION_DURATION_TICK_MS);
    });

    const statusCell = getStatusCell("About to go stale");
    expect(statusCell).toHaveTextContent("Stale");
    expect(statusCell).not.toHaveTextContent("Active");
  });
});

describe("SyncedSessionsTable — ISS-4996 repository absent vs malformed", () => {
  // SES-78746: both repository fields null, rendered as the literal "Unknown"
  // while the Branch cell beside it rendered an em dash for the same condition.
  const absentRepo = createAgentSessionListItemFixture({
    id: "absent-repo",
    name: "Absent repo session",
    repositoryFullName: null,
    repo: null,
  });

  const malformedRepo = createAgentSessionListItemFixture({
    id: "malformed-repo",
    name: "Malformed repo session",
    repositoryFullName: "",
    repo: null,
  });

  it("renders a null repository and an empty-string repository DIFFERENTLY", () => {
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[absentRepo, malformedRepo]}
      />
    );

    const absentCell = getRepoCellForSessionName("Absent repo session");
    const malformedCell = getRepoCellForSessionName("Malformed repo session");

    expect(absentCell.textContent?.trim()).toMatch(GRID_EMPTY_VALUE_TEXT_REGEX);
    expect(malformedCell.textContent?.trim()).toMatch(
      REPOSITORY_MALFORMED_TEXT_REGEX
    );
    expect(absentCell.textContent).not.toEqual(malformedCell.textContent);
    // #4324 review: two glyphs in one column are only honest if the reader can
    // decode them, so the malformed cell must EXPLAIN itself rather than ship a
    // bare word. These suites render tooltip content inline, so the explanation
    // is asserted on the cell's own text.
    expect(malformedCell.textContent).toContain(
      SESSION_REPOSITORY_MALFORMED_TOOLTIP
    );
  });

  it("gives an absent repository the SAME glyph the Branch column uses for the same condition", () => {
    const noRepoNoBranch = createAgentSessionListItemFixture({
      id: "no-repo-no-branch",
      name: "No repo no branch",
      repositoryFullName: null,
      repo: null,
      branch: null,
    });
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[noRepoNoBranch]}
      />
    );

    const repoCell = getRepoCellForSessionName("No repo no branch");
    // ISS-5315 renamed the column; the fact it states for an absent branch is
    // unchanged, which is exactly what this comparison is about.
    const branchCell = getGridCellForSessionName(
      "No repo no branch",
      "Linked branches"
    );
    expect(repoCell.textContent?.trim()).toEqual(
      branchCell.textContent?.trim()
    );
  });
});
