import type { AgentSessionLastSyncTarget } from "@repo/api/src/types/agent-session";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextCards } from "../context-cards";

// Pinned clock, so the relative labels the card renders are deterministic
// (AGENTS.md Test Practices — never assert against the real wall clock).
const NOW = new Date("2026-07-31T12:00:00.000Z");
// The ISS-4828 shape: seen 20s ago, a batch accepted 5 minutes ago that carried
// no new sessions, and session rows that last LANDED three days ago. The three
// ages are chosen to fold to three DISTINCT relative labels ("Just now",
// "5 min ago", "3 days ago") so an assertion on one column can never be
// satisfied by another column's text.
const LAST_SEEN_AT = new Date("2026-07-31T11:59:40.000Z");
const LAST_ACCEPTED_SYNC_AT = new Date("2026-07-31T11:55:00.000Z");
const LAST_INGEST_AT = new Date("2026-07-28T12:00:00.000Z");

const RELATIVE_DAYS_TEXT = /3 days ago/;
const RELATIVE_ACCEPTED_SYNC_TEXT = /5 min ago/;
const NEVER_TEXT = /Never/;

function buildTarget(
  overrides: Partial<AgentSessionLastSyncTarget> = {}
): AgentSessionLastSyncTarget {
  return {
    computeTargetId: "target-4828",
    machineName: "Ada's MacBook Pro",
    isOnline: true,
    lastSeenAt: LAST_SEEN_AT,
    lastAgentSessionSyncAt: LAST_INGEST_AT,
    lastAgentSessionSyncAttemptAt: LAST_ACCEPTED_SYNC_AT,
    owner: {
      id: "user-1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    },
    ...overrides,
  };
}

// ISS-5280: seeds NO enabled flags. The corrected sync semantics are
// unconditional now, so every assertion below has to hold with the flag port
// reporting everything off — if a gate came back, these fail.
function renderCards(targets: AgentSessionLastSyncTarget[]): void {
  render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <ContextCards targets={targets} />
    </AppCoreStoryProviders>
  );
}

/**
 * Read the freshness table BY COLUMN. Review, PR #4256 added a "Last New Data"
 * column alongside "Last Sync", so a bare text query can no longer tell which
 * column a timestamp came from — and "the accepted-sync value is in the Last
 * Sync column" is exactly the contract these tests exist to pin.
 */
function freshnessHeaders(): string[] {
  const [headerRow] = screen.getAllByRole("row");
  return Array.from(headerRow.querySelectorAll("th")).map(
    (cell) => cell.textContent ?? ""
  );
}

function freshnessCell(columnLabel: string): string {
  const columnIndex = freshnessHeaders().indexOf(columnLabel);
  const [, firstDataRow] = screen.getAllByRole("row");
  const cells = Array.from(firstDataRow.querySelectorAll("td"));
  return cells[columnIndex]?.textContent ?? "";
}

describe("ContextCards — compute-target sync semantics (ISS-4828, ungated)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the ACCEPTED-sync timestamp, and the corrected description with it", () => {
    renderCards([buildTarget()]);

    // The honest answer to "last successful sync": the target reached the cloud
    // 5 minutes ago, even though it had no new sessions to send.
    expect(freshnessCell("Last Sync")).toMatch(RELATIVE_ACCEPTED_SYNC_TEXT);
    // Neither superseded description may come back. The first predates ISS-4828;
    // the second (ISS-5280 review) made a claim about the "Last Sync" column
    // that the version-skew fallback below cannot honour, so the card now
    // orients without naming a column.
    expect(
      screen.queryByText("Last successful sync timestamps per compute target.")
    ).toBeNull();
    expect(
      screen.queryByText(
        "Last successful sync per compute target, even when there was nothing new to send."
      )
    ).toBeNull();
    expect(screen.getByText("Sync freshness per compute target.")).toBeTruthy();
  });

  it("keeps the LANDED-DATA signal on screen in its own column", () => {
    // Review, PR #4256: correcting "Last Sync" to the accepted-batch watermark
    // must not take "when did this machine's data last land" off the card — the
    // two answer different questions and belong side by side.
    renderCards([buildTarget()]);

    expect(freshnessHeaders()).toContain("Last New Data");
    expect(freshnessCell("Last New Data")).toMatch(RELATIVE_DAYS_TEXT);
    expect(freshnessCell("Last Sync")).toMatch(RELATIVE_ACCEPTED_SYNC_TEXT);
  });

  it("falls back to the landed-data timestamp when a version-skewed producer omits the accepted-sync field", () => {
    // The desktop's local usage summary and any older cloud producer omit the
    // optional field entirely. A populated row must never look LESS synced than
    // it did before ISS-4828 corrected the semantics.
    renderCards([buildTarget({ lastAgentSessionSyncAttemptAt: undefined })]);

    expect(freshnessCell("Last Sync")).toMatch(RELATIVE_DAYS_TEXT);
    expect(screen.queryByText(NEVER_TEXT)).toBeNull();
  });

  it("shows Never for a target that has neither synced nor ingested", () => {
    renderCards([
      buildTarget({
        lastAgentSessionSyncAt: null,
        lastAgentSessionSyncAttemptAt: null,
      }),
    ]);

    // Both columns read the honest "Never" — neither borrows the other's value.
    expect(freshnessCell("Last Sync")).toMatch(NEVER_TEXT);
    expect(freshnessCell("Last New Data")).toMatch(NEVER_TEXT);
  });
});
