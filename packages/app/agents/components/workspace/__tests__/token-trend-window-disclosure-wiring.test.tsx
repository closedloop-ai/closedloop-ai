import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../../shared/feature-flags/static-feature-flag-adapter";
import { TOKEN_TREND_WINDOW_DISCLOSURE_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { TokenTrendChart } from "../token-trend-chart";

/**
 * ISS-9622 — the WIRING, not the sentence. `token-trend-window-readout.test.ts`
 * proves the sentence; nothing there notices if the chart stops reading
 * `appliedWindow` / `truncated` at all, which is precisely the state ISS-6887
 * left the repo in: the producer stated its bound and no client rendered it.
 * This drives the real component through the real flag port, so deleting the
 * call site turns this red instead of leaving the suite green with the lie back.
 */

const mockUseTokenTrend = vi.fn();
vi.mock("../../../hooks/use-agent-component-token-trend", () => ({
  useAgentComponentTokenTrend: (slug: string) => mockUseTokenTrend(slug),
}));

const RE_WINDOW = /last 90 days/i;
const RE_TRUNCATED = /most recent sessions only/i;

// A population LARGER THAN ONE READ: the producer hit its raw-row ceiling, so
// these points are a prefix of the window, and the surface must say so.
const truncatedResponse: TokenTrendResponse = {
  slug: "skill::rtk",
  models: ["claude-opus-4-5"],
  points: [
    {
      sessionId: "s1",
      sessionStartedAt: "2026-08-01T10:00:00.000Z",
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.1,
      runtimeMs: 1000,
      componentInvocations: 1,
      componentErrorCount: 0,
    },
  ],
  appliedWindow: {
    since: "2026-06-08T12:00:00.000Z",
    until: "2026-09-06T12:00:00.000Z",
  },
  truncated: true,
};

const completeResponse: TokenTrendResponse = {
  ...truncatedResponse,
  truncated: undefined,
};

const legacyResponse: TokenTrendResponse = {
  ...truncatedResponse,
  appliedWindow: undefined,
  truncated: undefined,
};

function renderWithFlag(node: ReactNode, enabled: boolean) {
  const adapter = createStaticFeatureFlagAdapter({
    enabledFlags: enabled
      ? [TOKEN_TREND_WINDOW_DISCLOSURE_FEATURE_FLAG_KEY]
      : [],
  });
  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      {node}
    </FeatureFlagAdapterProvider>
  );
}

function chart() {
  return (
    <TokenTrendChart
      sessions={1}
      slug="skill::rtk"
      usageSessions={[]}
      versions={[]}
    />
  );
}

describe("TokenTrendChart window disclosure wiring (ISS-9622)", () => {
  it("discloses the window and the truncation once the gate is open", () => {
    mockUseTokenTrend.mockReturnValue({
      data: truncatedResponse,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithFlag(chart(), true);

    expect(screen.getByText(RE_WINDOW)).toBeInTheDocument();
    expect(screen.getByText(RE_TRUNCATED)).toBeInTheDocument();
  });

  it("states the window without claiming truncation when nothing was dropped", () => {
    mockUseTokenTrend.mockReturnValue({
      data: completeResponse,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithFlag(chart(), true);

    expect(screen.getByText(RE_WINDOW)).toBeInTheDocument();
    expect(screen.queryByText(RE_TRUNCATED)).not.toBeInTheDocument();
  });

  // Version skew: a producer predating ISS-6887 sends neither field. The gate
  // being open must not invent a bound it never stated.
  it("stays silent for a producer that discloses no window", () => {
    mockUseTokenTrend.mockReturnValue({
      data: legacyResponse,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithFlag(chart(), true);

    expect(screen.queryByText(RE_WINDOW)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_TRUNCATED)).not.toBeInTheDocument();
  });

  it("renders exactly as before while the gate is closed", () => {
    mockUseTokenTrend.mockReturnValue({
      data: truncatedResponse,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithFlag(chart(), false);

    expect(screen.queryByText(RE_WINDOW)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_TRUNCATED)).not.toBeInTheDocument();
  });
});
