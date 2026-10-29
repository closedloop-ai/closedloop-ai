/**
 * ISS-7175 (DOC-15 gap 4): the Sessions-list tile and the Session-detail row
 * must report the SAME token sum.
 *
 * The tile summed `input + output` — DOC-15's `Uncached Tokens per Session` —
 * while calling itself "Total Tokens", and the detail row printed all four
 * counters (`Total Tokens per Session`) under the bare word "Tokens". So the
 * same Session read an order of magnitude apart on the two screens whenever
 * `cache_read` dominated, and the label saying "Total" sat on the SMALLER of the
 * pair. The fix moved the tile's COMPUTATION onto all four counters rather than
 * narrowing its label.
 *
 * Deliberately ONE file rendering BOTH surfaces off ONE set of counters. Each
 * surface's own suite can only see its own number, and both were green while the
 * two disagreed — the defect is the RELATIONSHIP, so only a test holding both
 * can fail on it.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type { SessionSummaryDeltas } from "@repo/app/agents/lib/session-summary-deltas";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../../detail/agent-session-detail-fixtures";
import { SessionTokensProperty } from "../../detail/session-measured-properties";
import {
  SESSION_TIMELINE_TOTAL_TOKENS_UNIT,
  SESSION_TOKENS_PROPERTY_LABEL,
} from "../../detail/session-property-labels";
import { TOTAL_TOKENS_METRIC_CARD_LABEL } from "../sessions-summary-card-labels";
import { SessionsSummaryCards } from "../sessions-summary-cards";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * One Session's four counters, with cache deliberately dwarfing the uncached
 * pair the way a real Claude Code run does. Summing only input+output gives
 * 1,500 ("1.50k"); summing all four gives 9,201,500 ("9.20M"). Six thousand
 * times apart, so no assertion below can pass on the wrong basis.
 */
const INPUT_TOKENS = 1000;
const OUTPUT_TOKENS = 500;
const CACHE_READ_TOKENS = 9_000_000;
const CACHE_WRITE_TOKENS = 200_000;
const UNCACHED_ONLY_RENDER = "1.50k";
const ALL_FOUR_RENDER = "9.20M";
/** `KPI_NO_VALUE` — the honest-empty glyph a tile renders instead of a figure. */
const TILE_NO_VALUE_GLYPH = "—";

/**
 * A movement for BOTH tiles, so the assertions below can tell "the tokens chip
 * was suppressed" apart from "deltas were off entirely".
 */
const SESSIONS_DELTA_TEXT = "+12%";
const TOKENS_DELTA_TEXT = "+37%";
const BOTH_TILE_DELTAS: SessionSummaryDeltas = {
  label: "vs. prior 30 days",
  sessions: { delta: 12, deltaPolarity: MetricPolarity.HigherIsBetter },
  tokens: { delta: 37, deltaPolarity: MetricPolarity.HigherIsBetter },
};

function oneSessionUsage(): AgentSessionUsageSummary {
  return {
    viewerScope: AgentSessionViewerScope.Organization,
    totalSessions: 1,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: INPUT_TOKENS,
    totalOutputTokens: OUTPUT_TOKENS,
    totalCacheReadTokens: CACHE_READ_TOKENS,
    totalCacheWriteTokens: CACHE_WRITE_TOKENS,
    totalEstimatedCost: 42,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 42,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
  };
}

function cardFor(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error(`No metric card found for label "${label}"`);
  }
  return card;
}

describe("ISS-7175: the list tile and the detail row report one token sum", () => {
  it("the Total Tokens tile counts cache, not just the uncached pair", () => {
    render(
      <SessionsSummaryCards isLoading={false} usage={oneSessionUsage()} />
    );

    const tile = within(cardFor(TOTAL_TOKENS_METRIC_CARD_LABEL));
    expect(tile.getByText(ALL_FOUR_RENDER)).toBeInTheDocument();
    // The exact figure the tile used to print. Asserting its ABSENCE is what
    // makes this test fail on the old derivation rather than merely pass on the
    // new one — a tile still summing input+output renders this string.
    expect(screen.queryByText(UNCACHED_ONLY_RENDER)).toBeNull();
    // Moved here from `sessions-summary-cards.test.tsx` (which sits against the
    // 1,000-line ceiling) when this file took over the tile's token coverage:
    // the headline is abbreviated by `formatTokenCount`, so it reads like every
    // other token display in the product rather than raw grouping.
    expect(
      screen.queryByText(
        (
          INPUT_TOKENS +
          OUTPUT_TOKENS +
          CACHE_READ_TOKENS +
          CACHE_WRITE_TOKENS
        ).toLocaleString()
      )
    ).toBeNull();
  });

  it("the detail row prints the four counters that add up to the tile", () => {
    const { container } = render(
      <SessionTokensProperty
        session={createAgentSessionDetailFixture({
          cache: CACHE_READ_TOKENS,
          cacheWrite: CACHE_WRITE_TOKENS,
          tokensIn: INPUT_TOKENS,
          tokensOut: OUTPUT_TOKENS,
        })}
      />
    );

    expect(screen.getByText(SESSION_TOKENS_PROPERTY_LABEL)).toBeInTheDocument();
    for (const counter of [
      INPUT_TOKENS,
      OUTPUT_TOKENS,
      CACHE_READ_TOKENS,
      CACHE_WRITE_TOKENS,
    ]) {
      expect(container.textContent).toContain(counter.toLocaleString());
    }
  });

  it("dashes the tile on a corrupt counter instead of printing a wrong total", () => {
    // ISS-7175 (review): widening the tile onto the cache counters doubled the
    // inputs that can poison its headline, and `formatTokenCount` has no
    // finite/negative guard — a `-1` would have rendered a confident total wrong
    // by exactly that term, beside a Cost tile that correctly dashes on the same
    // payload. Production path, not the helper: this asserts what the tile
    // RENDERS, so deleting the guard at the call site fails here.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={{ ...oneSessionUsage(), totalCacheReadTokens: -1 }}
      />
    );

    const tile = within(cardFor(TOTAL_TOKENS_METRIC_CARD_LABEL));
    expect(tile.getByText(TILE_NO_VALUE_GLYPH)).toBeInTheDocument();
    // The number an unguarded fold would have printed: 9,201,500 - 9,000,000 - 1
    // rounds to "202k". Its absence is what makes this fail on the unguarded
    // version rather than merely pass on the guarded one.
    expect(screen.queryByText("202k")).toBeNull();
  });

  it("drops the tokens chip when the tile dashes, without silencing its rowmate", () => {
    // ISS-7175 (review): the dash and the chip are computed independently —
    // `comparableDeltas` drops out on loading / error / local fallback, none of
    // which covers a corrupt counter. Ungated, the tile paints its no-data glyph
    // with a live "+37% vs. prior 30 days" under it, grading a movement in a
    // value it just declined to state. Second-order and worse: that movement is
    // computed server-side by `sumSessionTokenCounters`, which does not validate
    // its terms — so the chip would grade the very counter this tile refused.
    render(
      <SessionsSummaryCards
        deltas={BOTH_TILE_DELTAS}
        isLoading={false}
        usage={{ ...oneSessionUsage(), totalCacheReadTokens: -1 }}
      />
    );

    const tile = within(cardFor(TOTAL_TOKENS_METRIC_CARD_LABEL));
    expect(tile.getByText(TILE_NO_VALUE_GLYPH)).toBeInTheDocument();
    expect(screen.queryByText(TOKENS_DELTA_TEXT)).toBeNull();
    // The Sessions tile beside it still grades its own movement — the
    // suppression is scoped to the tile that dashed, not a blanket deltas-off.
    expect(screen.getByText(SESSIONS_DELTA_TEXT)).toBeInTheDocument();
    // And the caption stops reciting a composition for a number that was never
    // computed, the way the Cost tile swaps its own in this state.
    expect(tile.queryByText("input + output + cache")).toBeNull();
  });

  it("names the SUM on the two elements that show a sum, and only those", () => {
    // ISS-7175 (Cosimo, 2026-08-22). The word "Total" belongs to whatever renders
    // a total. Two elements do — the Sessions-list tile and the Session Timeline
    // strip's token fact — and they must name the same quantity, since both sum
    // all four counters through `formatTokenCount`.
    expect(TOTAL_TOKENS_METRIC_CARD_LABEL).toBe("Total Tokens");
    expect(SESSION_TIMELINE_TOTAL_TOKENS_UNIT).toBe("total tokens");
    // Same words, differing only in case: the tile's is a title-case card label,
    // the strip's a unit beside a figure ("9.20M total tokens"). Pinning the
    // relationship rather than the two texts alone is what catches a rename of
    // one that a reader would expect the other to follow.
    expect(SESSION_TIMELINE_TOTAL_TOKENS_UNIT.toLowerCase()).toBe(
      TOTAL_TOKENS_METRIC_CARD_LABEL.toLowerCase()
    );

    // And the Properties row keeps the PLAIN noun, because it is the element
    // that shows the four counters broken out and never their sum. Calling it
    // "Total" would put the word on the one thing on that screen not showing a
    // total — the inversion this ticket exists to close, rebuilt inside one
    // screen. Both shells' Playwright specs select on this text.
    expect(SESSION_TOKENS_PROPERTY_LABEL).toBe("Tokens");
    expect(SESSION_TOKENS_PROPERTY_LABEL).not.toBe(
      TOTAL_TOKENS_METRIC_CARD_LABEL
    );
  });
});
