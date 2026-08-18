import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { withProviders } from "./agent-session-detail-view.test-helpers";

// FEA-3993: Codex rate-limit rows are named by their own window duration.
const RATE_LIMIT_LABEL_REGEX = /Rate limit/;
const RATE_LIMIT_WEEKLY_LABEL_REGEX = /Rate limit \(weekly\)/;

// `info` alongside `success`/`error`: ISS-6006 made the Session Timeline's jump
// reporting unconditional, so a click on a bar or dot that cannot land now calls
// `toast.info` in every harness that mounts this view — an incomplete mock
// crashes the click handler instead of exercising it.
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

describe("FEA-3703 / FEA-3993 Codex runtime metadata rows (ungated)", () => {
  // resets_at is an ABSOLUTE Unix epoch-seconds timestamp (matching the raw
  // Codex payload), so the "resets in Nm" copy is computed against the wall
  // clock. Pin the clock so the rendered remaining time is deterministic.
  const NOW_EPOCH_SECONDS = 1_780_000_000;
  const NOW_MS = NOW_EPOCH_SECONDS * 1000;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const codexFixture = createAgentSessionDetailFixture({
    metadata: {
      branch: "fea-3703",
      modelContextWindow: 200_000,
      codexLastTokenUsage: [
        {
          timestamp: "2026-07-22T00:00:00.000Z",
          model: "gpt-5",
          lastTokenUsage: {
            input: 40_000,
            output: 8000,
            cacheRead: 10_000,
            cacheWrite: 2000,
          },
        },
      ],
      codexRateLimits: {
        // resets 30 minutes from the pinned clock.
        primary: {
          used_percent: 42,
          window_minutes: 300,
          resets_at: NOW_EPOCH_SECONDS + 1800,
        },
        secondary: null,
      },
    },
  });

  async function openProperties() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Properties" }));
  }

  it("renders context window (with utilization), latest turn counts, and rate-limit rows for a Codex session (no flag required)", async () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={codexFixture}
        />
      )
    );

    await openProperties();

    expect(
      screen.getByText("Context window").closest(".prd-prop")
    ).toHaveTextContent("200,000 tokens | 30% used (latest turn)");
    // No "this turn:" prefix — the label already says it (FEA-3993).
    expect(
      screen.getByText("Latest turn tokens").closest(".prd-prop")
    ).toHaveTextContent(
      "40,000 in | 8,000 out | 10,000 cache read | 2,000 cache write"
    );
    expect(
      screen.getByText("Latest turn tokens").closest(".prd-prop")
    ).not.toHaveTextContent("this turn:");
    // Row is named by its own window (300m -> 5h), and the redundant "Nm window"
    // fragment is gone from the value (FEA-3993).
    const primaryRow = screen.getByText("Rate limit (5h)").closest(".prd-prop");
    expect(primaryRow).toHaveTextContent("42% used | resets in 30m");
    expect(primaryRow).not.toHaveTextContent("window");
    // Secondary window absent -> no secondary row (no lying UI).
    expect(
      screen.queryByText(RATE_LIMIT_WEEKLY_LABEL_REGEX)
    ).not.toBeInTheDocument();
  });

  it("drops the used fragment (no bare-dash glyph) when used_percent is missing", async () => {
    const missingPercentFixture = createAgentSessionDetailFixture({
      metadata: {
        branch: "fea-3703",
        codexRateLimits: {
          // resets 15 minutes from the pinned clock; used_percent absent.
          primary: {
            used_percent: null,
            window_minutes: 60,
            resets_at: NOW_EPOCH_SECONDS + 900,
          },
          secondary: null,
        },
      },
    });

    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={missingPercentFixture}
        />
      )
    );

    await openProperties();

    // 60m window -> "1h" label; value leads with the reset, no "— used" /
    // bare-dash fragment.
    const row = screen.getByText("Rate limit (1h)").closest(".prd-prop");
    expect(row).toHaveTextContent("resets in 15m");
    expect(row).not.toHaveTextContent("used");
  });

  it("renders 'resets now' for a reset epoch already in the past (no negative minutes)", async () => {
    const pastResetFixture = createAgentSessionDetailFixture({
      metadata: {
        branch: "fea-3703",
        codexRateLimits: {
          // resets_at 10 minutes BEFORE the pinned clock -> already elapsed.
          primary: {
            used_percent: 88,
            window_minutes: 300,
            resets_at: NOW_EPOCH_SECONDS - 600,
          },
          secondary: null,
        },
      },
    });

    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={pastResetFixture}
        />
      )
    );

    await openProperties();

    const row = screen.getByText("Rate limit (5h)").closest(".prd-prop");
    expect(row).toHaveTextContent("88% used | resets now");
    // The raw ~1.78-billion epoch must never leak as minutes.
    expect(row).not.toHaveTextContent("resets in");
  });

  it("keeps the rows hidden for a non-Codex session (presence self-gate intact, no flag)", async () => {
    // FEA-3993: the feature is ungated, so the only gate left is presence.
    // A session that carries no Codex runtime metadata must still render nothing.
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      )
    );

    await openProperties();

    expect(screen.queryByText("Context window")).not.toBeInTheDocument();
    expect(screen.queryByText("Latest turn tokens")).not.toBeInTheDocument();
    expect(screen.queryByText(RATE_LIMIT_LABEL_REGEX)).not.toBeInTheDocument();
  });

  it("names the weekly secondary window and renders its reset in d/h, not raw minutes", async () => {
    // The reviewer's case: a 7-day (10,080m) secondary window whose reset is ~6
    // days out. Raw minutes ("10,080m window | resets in 8,742m") read as
    // nothing; the label is "weekly" and the reset collapses to d/h.
    const weeklyFixture = createAgentSessionDetailFixture({
      metadata: {
        branch: "fea-3993",
        codexRateLimits: {
          primary: {
            used_percent: 12,
            window_minutes: 300,
            resets_at: NOW_EPOCH_SECONDS + 3600,
          },
          secondary: {
            used_percent: 63,
            window_minutes: 10_080,
            // 6 days + 1 hour from the pinned clock.
            resets_at: NOW_EPOCH_SECONDS + (6 * 24 + 1) * 3600,
          },
        },
      },
    });

    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={weeklyFixture}
        />
      )
    );

    await openProperties();

    const weeklyRow = screen
      .getByText("Rate limit (weekly)")
      .closest(".prd-prop");
    expect(weeklyRow).toHaveTextContent("63% used | resets in 6d 1h");
    // Never the raw-minutes rendering the reviewer flagged.
    expect(weeklyRow).not.toHaveTextContent("10,080m");
    expect(weeklyRow).not.toHaveTextContent("8,74");
    // The 5h primary still renders alongside it.
    expect(
      screen.getByText("Rate limit (5h)").closest(".prd-prop")
    ).toHaveTextContent("12% used | resets in 1h");
  });
});
