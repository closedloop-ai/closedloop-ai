import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSyncStatusBadge } from "../session-sync-status-badge";

// Pin the clock so any derived relative freshness is deterministic (AGENTS.md
// Test Practices). SYNCED_AT would fold to "11 min ago" if freshness were shown.
const NOW = new Date("2026-06-10T12:30:00.000Z");
const SYNCED_AT = new Date("2026-06-10T12:19:00.000Z");

// Hoisted to top-level scope (biome performance/useTopLevelRegex) so the matcher
// literals aren't reconstructed on every assertion.
const SYNCED_TEXT = /Synced/;
const LAST_SYNCED_TEXT = /Last synced/;

function renderBadge(
  session: Pick<AgentSessionListItem, "lastSyncedAt" | "transcriptDisposition">
): void {
  render(<SessionSyncStatusBadge session={session} />);
}

describe("SessionSyncStatusBadge (PRD-536 G1 Phase 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing for a nominal synced verdict — the list shows the exception, not the steady state", () => {
    renderBadge({
      transcriptDisposition: TranscriptDisposition.Synced,
      lastSyncedAt: SYNCED_AT,
    });

    // The healthy "Last synced …" freshness lives on the detail Properties Sync
    // row, not on every list row (design-critic, PR #3457) — a synced row is
    // silent on the list so a healthy fleet isn't a wall of freshness strings.
    expect(screen.queryByText(SYNCED_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(LAST_SYNCED_TEXT)).not.toBeInTheDocument();
  });

  it("escalates a stale verdict to a colored attention badge (verdict label only, no freshness string)", () => {
    renderBadge({
      transcriptDisposition: TranscriptDisposition.Stale,
      lastSyncedAt: SYNCED_AT,
    });

    // Attention rows show the bare verdict label — freshness is not repeated in
    // the name column beside the existing "Last active" column.
    const label = screen.getByText("Stale");
    expect(label).toBeInTheDocument();
    expect(screen.queryByText(LAST_SYNCED_TEXT)).not.toBeInTheDocument();
    // Attention treatment: the ToneBadge carries the warning tone token.
    expect(document.body.innerHTML).toContain("warning");
  });

  it("escalates a syncing verdict to an attention badge", () => {
    renderBadge({ transcriptDisposition: TranscriptDisposition.Syncing });

    expect(screen.getByText("Syncing")).toBeInTheDocument();
  });

  it("escalates a failed verdict to an attention badge", () => {
    renderBadge({
      transcriptDisposition: TranscriptDisposition.FailedPermanent,
    });

    expect(screen.getByText("Sync failed")).toBeInTheDocument();
  });

  it("renders nothing for a freshness-only row (no attention verdict) — the desktop-local case", () => {
    renderBadge({ lastSyncedAt: SYNCED_AT });

    // A disposition-absent row is nominal — freshness alone never draws attention
    // on the list, and no verdict is fabricated.
    expect(screen.queryByText(LAST_SYNCED_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(SYNCED_TEXT)).not.toBeInTheDocument();
  });

  it("renders nothing when the row carries neither field (degrades safely)", () => {
    renderBadge({});

    expect(screen.queryByText(LAST_SYNCED_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(SYNCED_TEXT)).not.toBeInTheDocument();
  });
});
