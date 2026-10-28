import {
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
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

/*
 * ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23) retired the two words
 * this describe was built around. Verbatim: "Unparsable status are already
 * converted to Active on import. Don't distinguish between active and stale."
 *
 * ISS-4997 and ISS-4998 answered a real defect — a row claiming "Active" on
 * evidence that did not support it — with two honest non-claims. The ruling
 * removes the non-claims rather than the defect, so these cases are KEPT as
 * counterfactuals: same fixtures, same silence, same unreadable spelling, now
 * asserting the Active the ruling requires. Anything that quietly reintroduces a
 * silence cutoff has to edit them.
 */
describe("SyncedSessionsTable — ISS-10364 one status vocabulary", () => {
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

  it("ISS-10364: a session silent for 63 hours renders Active", () => {
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[staleActive]}
      />
    );

    const statusCell = getStatusCell("Stale active session");
    expect(statusCell).toHaveTextContent(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );
  });

  it("ISS-10364: an unrecognized status renders Active", () => {
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[versionSkewed]}
      />
    );

    const statusCell = getStatusCell("Version skewed session");
    expect(statusCell).toHaveTextContent(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );
  });

  it("leaves a genuinely-live session reading Active", () => {
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[liveActive]}
      />
    );

    expect(getStatusCell("Live active session")).toHaveTextContent(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );
  });

  it("ISS-10364: crossing the old staleness cutoff no longer changes the badge", async () => {
    // ISS-4998 mounted a row just inside the threshold, advanced the clock past
    // it WITHOUT touching `items`, and required the badge to correct itself —
    // because the fold read the CURRENT time while the row mapping is memoized on
    // an array TanStack keeps referentially stable across unchanged refetches.
    //
    // The fold no longer reads a clock, so there is nothing to correct. The case
    // is kept because the SETUP is the falsifiable half: it still crosses the old
    // cutoff on a stable `items` identity, so a change that reintroduced a
    // time-dependent fold would flip this assertion rather than slip through.
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

    expect(getStatusCell("About to go stale")).toHaveTextContent(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );

    // Cross the threshold with the SAME items array identity.
    await act(async () => {
      vi.setSystemTime(new Date(NOW.getTime() + 4 * 60_000));
      await vi.advanceTimersByTimeAsync(SESSION_DURATION_TICK_MS);
    });

    const statusCell = getStatusCell("About to go stale");
    expect(statusCell).toHaveTextContent(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );
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
