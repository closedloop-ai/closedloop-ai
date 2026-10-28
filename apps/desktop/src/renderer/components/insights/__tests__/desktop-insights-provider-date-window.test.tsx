import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { useInsightsDataSource } from "@repo/app/insights/data/insights-data-source";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { DesktopInsightsProvider } from "../desktop-insights-provider";

/**
 * @file desktop-insights-provider-date-window.test.tsx
 * @description The ISS-10413 / ISS-10604 half of `DesktopInsightsProvider`: the
 * bound on the best-effort local overlay read, and the session date basis the
 * renderer resolves and sends with every local insights read.
 *
 * A SIBLING FILE rather than more cases in `desktop-insights-provider.test.tsx`,
 * which these additions pushed to 1,032 logical lines — past the 1,000-line hard
 * ceiling. The harness below is deliberately its own copy: `vi.mock` is hoisted
 * per FILE, so the module mocks cannot be shared from a helper module the way
 * `local-insights-test-helpers.ts` shares its database fixture.
 */

const {
  useDesktopAuthMock,
  useDesktopAppCoreModeMock,
  useApiClientMock,
  apiGetMock,
  getInsightsMock,
  useFeatureFlagEnabledOptionalMock,
} = vi.hoisted(() => ({
  useDesktopAuthMock: vi.fn(),
  useDesktopAppCoreModeMock: vi.fn(),
  useApiClientMock: vi.fn(),
  apiGetMock: vi.fn(async () => ({ charts: {}, kpis: [] })),
  getInsightsMock: vi.fn(async () => ({ charts: {}, kpis: [] })),
  // ISS-10604: default `undefined` — the flag unresolved — which folds to the
  // pre-alignment basis, so a case that says nothing about the flag pins what a
  // viewer outside the rollout gets.
  useFeatureFlagEnabledOptionalMock: vi.fn(
    () => undefined as boolean | undefined
  ),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: useDesktopAppCoreModeMock,
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: useApiClientMock,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: useFeatureFlagEnabledOptionalMock,
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

/**
 * ISS-10413 — the bound on the local overlay read.
 *
 * `readCloudSectionWithLocalOverlay` awaits both reads together. The local one
 * is a SQLite aggregate against the same store the importer is writing, so
 * during a first-launch import it can outlast the range change that triggered
 * it — and `keepPreviousData` reports an unsettled new query key as `success`,
 * so the tiles go on rendering the previous period's numbers under the new
 * period's label. Delivery is unaffected because it takes no overlay, which is
 * exactly the split ISS-10413 reported: Cost and Merged PRs moved, Sessions did
 * not.
 *
 * Written here as a literal rather than imported from the module under test: a
 * fixture that reads its deadline from the code it polices cannot fail when that
 * deadline is deleted.
 */
const OVERLAY_DEADLINE_MS = 4000;

describe("DesktopInsightsProvider local overlay deadline (ISS-10413)", () => {
  beforeEach(resetMocks);
  afterEach(() => {
    // Unconditional, never the last line of a case: a case that throws between
    // `useFakeTimers` and a per-case restore would leak a frozen clock into
    // every later test in this worker, and `restoreAllMocks` does not cover
    // timers.
    vi.useRealTimers();
    resetMocks();
  });

  it("delivers the cloud response when the local overlay read never settles", async () => {
    vi.useFakeTimers();
    const cloudHeatmap = {
      days: ["2026-07-01"],
      cells: [
        { day: "2026-07-01", hour: 9, human: 1, agent: 2 },
        { day: "2026-07-01", hour: 10, human: 0, agent: 3 },
      ],
    };
    apiGetMock.mockResolvedValue({
      kpis: [],
      charts: { activityHeatmap: cloudHeatmap },
    });
    // Never settles, and never rejects — the case the old `Promise.all` had no
    // answer for. A REJECTING local read was always handled; a slow one was not.
    getInsightsMock.mockImplementationOnce(() => new Promise(() => undefined));
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<UtilizationHeatmapProbe scope={InsightsScope.Me} />);

    // Held before the deadline. Without this half the case would pass on any
    // implementation that skipped the overlay entirely, which is a different
    // (and wrong) fix — the local slice must still get its chance.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLAY_DEADLINE_MS - 1);
    });
    expect(screen.getByText("heatmap-cells:pending")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // The CLOUD heatmap's two cells — so the section resolved with the cloud
    // response intact rather than resolving empty or erroring.
    expect(screen.getByText("heatmap-cells:2")).toBeTruthy();
  });

  it("still prefers the local slice when the local read beats the deadline", async () => {
    // The counterweight. A "fix" that simply stopped reading locally would pass
    // the case above and silently retire the FEA-3684 deploy-window fallback.
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue({ kpis: [], charts: {} });
    getInsightsMock.mockResolvedValueOnce({
      kpis: [],
      charts: {
        activityHeatmap: {
          days: ["2026-07-01"],
          cells: [{ day: "2026-07-01", hour: 9, human: 3, agent: 5 }],
        },
      },
    });
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<UtilizationHeatmapProbe scope={InsightsScope.Me} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("heatmap-cells:1")).toBeTruthy();
  });
});

describe("DesktopInsightsProvider session date basis (ISS-10541)", () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  it("sends NO date basis with a local read, whatever the flag service says", async () => {
    // ISS-10604 threaded a resolved basis as a fourth argument, gated on
    // `sessions-analytics-activity-window`; this file pinned both regimes.
    // ISS-10541 retired the cohort, so the renderer has no basis to send and no
    // flag to read. Asserting the ARITY rather than deleting the cases: while
    // the argument existed, a renderer could ask the main process for the
    // pre-alignment column, and the point of the retirement is that it cannot.
    //
    // `true` is the interesting value. It is what the never-created PostHog key
    // would have returned had anyone created it, so a provider that still read
    // a flag would reveal itself here rather than under `undefined`.
    useFeatureFlagEnabledOptionalMock.mockReturnValue(true);
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(
      authState({ state: { status: "signed_out" } })
    );
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);

    renderWithProvider(<InvokeReadsProbe scope={InsightsScope.Me} />);

    await waitFor(() =>
      expect(getInsightsMock).toHaveBeenCalledWith(
        InsightsSection.Utilization,
        "30",
        InsightsScope.Me
      )
    );
    // The positive assertion above pins the three arguments that DO go; this
    // pins that nothing follows them. `toHaveBeenCalledWith` compares the whole
    // array, so a fourth argument fails it — but stated separately because the
    // literals are what a reader checks and the arity is what regresses.
    for (const call of getInsightsMock.mock.calls) {
      expect(call).toHaveLength(3);
    }
  });
});

function resetMocks() {
  vi.restoreAllMocks();
  useDesktopAuthMock.mockReset();
  useDesktopAppCoreModeMock.mockReset();
  useApiClientMock.mockReset();
  useApiClientMock.mockReturnValue({ get: apiGetMock });
  apiGetMock.mockClear();
  getInsightsMock.mockClear();
  useFeatureFlagEnabledOptionalMock.mockReset();
  useFeatureFlagEnabledOptionalMock.mockReturnValue(undefined);
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
}

function UtilizationHeatmapProbe({ scope }: { scope: InsightsScope }) {
  const source = useInsightsDataSource();
  const [cellCount, setCellCount] = useState<number | null>(null);
  useEffect(() => {
    source
      .getUtilization("30", scope)
      .then((response) =>
        setCellCount(response.charts.activityHeatmap?.cells.length ?? 0)
      )
      .catch(() => setCellCount(-1));
  }, [source, scope]);
  return <div>heatmap-cells:{cellCount === null ? "pending" : cellCount}</div>;
}

function InvokeReadsProbe({ scope }: { scope: InsightsScope }) {
  const source = useInsightsDataSource();
  useEffect(() => {
    Promise.all([
      source.getDelivery("30", scope),
      source.getUtilization("30", scope),
      source.getAgents("30", scope),
    ]).catch(() => undefined);
  }, [source, scope]);
  return <div>scopes:{source.availableScopes.join(",")}</div>;
}

function renderWithProvider(children: ReactNode) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DesktopInsightsProvider>{children}</DesktopInsightsProvider>
    </QueryClientProvider>
  );
}

function installDesktopApi() {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: { getInsights: getInsightsMock },
      getGitHubIntegrationStatus: vi.fn(async () => null),
      openGitHubConnect: vi.fn(async () => ({ ok: true })),
    },
  });
}

function authState(
  overrides: Partial<{
    beginSignIn: ReturnType<typeof vi.fn>;
    state: { status: string };
  }> = {}
) {
  return {
    beginSignIn: vi.fn(async () => ({ ok: true })),
    state: { status: "authenticated" },
    ...overrides,
  };
}
