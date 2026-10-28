import { OnboardingAnalysisBanner } from "@repo/app/onboarding/components/onboarding-analysis-banner";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READY_AGENT_MONITOR_RUNTIME_STATUS } from "../../../shared/agent-monitor-status";
import { CloudStatusKind } from "../../hooks/use-cloud-status";
import type { IngestProgress } from "../../hooks/use-ingest-progress";
import { useStartupReadiness } from "../use-startup-readiness";
import { MEASURED_ANALYSIS } from "./startup-readiness-fixtures";

const inputs = vi.hoisted(() => ({
  ingest: null as IngestProgress | null,
}));

vi.mock("../../hooks/use-agent-monitor-status", () => ({
  useAgentMonitorStatus: () => READY_AGENT_MONITOR_RUNTIME_STATUS,
}));
vi.mock("../../components/sessions/use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: () => ({
    data: { totalSessions: 5 },
    isError: false,
  }),
}));
vi.mock("../../hooks/use-ingest-progress", () => ({
  useIngestProgress: () => inputs.ingest,
  useMaintenanceProgress: () => null,
}));
vi.mock("../../hooks/use-cloud-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/use-cloud-status")>()),
  useCloudStatus: () => ({
    kind: CloudStatusKind.Disabled,
    reason: "Cloud connection is off",
  }),
}));
vi.mock("../../hooks/use-cloud-sync-progress", () => ({
  useCloudSyncProgress: () => null,
  useCloudSyncBacklog: () => null,
}));

let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  inputs.ingest = {
    byHarness: [],
    total: 5,
    processed: 2,
    preparing: false,
    complete: false,
  };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

function Surface() {
  return (
    <OnboardingAnalysisBanner
      {...useStartupReadiness({
        analysis: MEASURED_ANALYSIS,
        syncElected: false,
      })}
    />
  );
}
// Every flag on, so no gate anywhere can be what keeps a control off this bar.
function Fixture() {
  return (
    <FeatureFlagAdapterProvider adapter={{ useFeatureFlagEnabled: () => true }}>
      <QueryClientProvider client={client}>
        <Surface />
      </QueryClientProvider>
    </FeatureFlagAdapterProvider>
  );
}
describe("useStartupReadiness — the banner's rendered progress surface", () => {
  it("states the parse counter and sweeps the bar, and carries no control at all", async () => {
    render(<Fixture />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    // The bar itself: the prototype's label while parsing (ISS-11668), the
    // `X / Y` counter, and a determinate, sweeping `<Progress>` line.
    expect(screen.getByText("Analyzing session records")).toBeTruthy();
    expect(screen.getByText("261 / 270")).toBeTruthy();
    const bar = screen.getByRole("progressbar", {
      name: "Session analysis status",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("97");
    // Nothing can hold the bar any more, so it always sweeps.
    expect(bar.querySelector('[data-slot="progress-sheen"]')).not.toBeNull();

    // ISS-10940, the removal. Queried by ROLE ALONE: the pause label is deleted
    // copy, so an absence assertion that named it would be satisfied by a
    // locator that has simply stopped matching anything. Sat beside the four
    // positive assertions above, which prove this render produced the bar.
    // ISS-11862: the bar is informational only (ISS-11668 expectation 4), so no
    // dismiss either, on a pass parked on `ProcessingHistory` with every flag on.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
