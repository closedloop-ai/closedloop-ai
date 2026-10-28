/**
 * Direct coverage for the superseded Diagnostics composition
 * (`diagnostics-legacy-body.tsx`), which the flag-routing test
 * (`diagnostics-v2-mount.test.tsx`) only ever mounts through `DiagnosticsView`
 * with the flag off and a minimal probe payload — enough to prove routing, not
 * enough to exercise the panel's own tabs, polling, or error handling.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsData } from "../../../../shared/diagnostics-contract";
import {
  DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY,
  DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY,
} from "../../../../shared/feature-flags-labs-detail";
import { DiagnosticsLegacyBody } from "../diagnostics-legacy-body";

const WITHHELD_TAB_LABEL = "Withheld";
const COVERAGE_TAB_LABEL = "Coverage";

const enabledFlags = vi.hoisted(() => new Set<string>());
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
}));
// Each section is stubbed with its own testid so a case can prove the selected
// tab renders ITS body; `aria-selected` alone is Radix's state and stays true
// even when the wrong section id is passed to `renderTabContent`.
const sectionStub = vi.hoisted(() => (testId: string) => () => (
  <div data-testid={testId} />
));
vi.mock("@repo/app/diagnostics/components/repos-section", () => ({
  ReposSection: sectionStub("repos-section"),
}));
vi.mock("@repo/app/diagnostics/components/backfill-section", () => ({
  BackfillSection: sectionStub("backfill-section"),
}));
vi.mock("@repo/app/diagnostics/components/links-section", () => ({
  LinksSection: sectionStub("links-section"),
}));
vi.mock("@repo/app/diagnostics/components/withheld-section", () => ({
  WithheldSection: sectionStub("withheld-section"),
}));
vi.mock("@repo/app/diagnostics/components/coverage-section", () => ({
  CoverageSection: ({ coverage }: { coverage?: unknown }) => (
    <div
      data-coverage={coverage === undefined ? "absent" : "present"}
      data-testid="coverage-section"
    />
  ),
}));
vi.mock("../LogsPanel", () => ({ LogsPanel: sectionStub("logs-panel") }));

beforeEach(() => {
  enabledFlags.clear();
});

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function emptyPayload(): DiagnosticsData {
  return {
    backfill: {
      artifactLinks: { lastScannedAt: null, totalScanned: 0 },
      prBackfill: { lastScannedAt: null, totalScanned: 0 },
    },
    linkStats: [],
    linkTotals: { linkedArtifacts: 0, linkedSessions: 0, totalLinks: 0 },
    repos: [],
    opencodeWithheld: [],
    opencodeWithheldScans: [],
  };
}

function installDiagnosticsApi(
  getDiagnostics: (request: { includeActivityCoverage?: boolean }) => unknown
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(getDiagnostics);
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { db: { getDiagnostics: fn } },
  });
  return fn;
}

afterEach(() => {
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

function isSelected(name: string): boolean {
  return (
    screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true"
  );
}

function activePanel(): HTMLElement {
  return screen.getByRole("tabpanel");
}

async function expectActiveSection(testId: string): Promise<void> {
  await waitFor(() =>
    expect(within(activePanel()).getByTestId(testId)).toBeTruthy()
  );
}

// Radix's Tabs trigger switches on pointer/mouse-down, not `click` — the same
// shape `diagnostics-surface-host.test.tsx` uses for its own tab strip.
function selectTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

describe("DiagnosticsLegacyBody — visibility gate", () => {
  it("never reads while inactive", () => {
    const getDiagnostics = installDiagnosticsApi(async () => emptyPayload());
    render(<DiagnosticsLegacyBody isActive={false} />);

    expect(getDiagnostics).not.toHaveBeenCalled();
  });

  it("reads once activated and renders the Repos tab by default", async () => {
    installDiagnosticsApi(async () => emptyPayload());
    render(<DiagnosticsLegacyBody />);

    await waitFor(() => expect(isSelected("Repos")).toBe(true));
    await expectActiveSection("repos-section");
  });
});

describe("DiagnosticsLegacyBody — tab switching over the shared sections", () => {
  it("renders Backfill, Links, and Gateway Logs when their tabs are selected", async () => {
    installDiagnosticsApi(async () => emptyPayload());
    render(<DiagnosticsLegacyBody />);
    await screen.findByRole("tab", { name: "Repos" });

    selectTab("Backfill");
    await waitFor(() => expect(isSelected("Backfill")).toBe(true));
    await expectActiveSection("backfill-section");

    selectTab("Links");
    await waitFor(() => expect(isSelected("Links")).toBe(true));
    await expectActiveSection("links-section");

    selectTab("Gateway Logs");
    await waitFor(() => expect(isSelected("Gateway Logs")).toBe(true));
    await expectActiveSection("logs-panel");
  });

  it("offers Withheld and Coverage tabs only when their Labs flags are on", async () => {
    installDiagnosticsApi(async () => emptyPayload());
    render(<DiagnosticsLegacyBody />);
    await screen.findByRole("tab", { name: "Repos" });

    expect(screen.queryByRole("tab", { name: WITHHELD_TAB_LABEL })).toBeNull();
    expect(screen.queryByRole("tab", { name: COVERAGE_TAB_LABEL })).toBeNull();
  });

  it("renders the Withheld and Coverage tabs when both Labs flags are on", async () => {
    enabledFlags.add(DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY);
    enabledFlags.add(DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY);
    const getDiagnostics = installDiagnosticsApi(
      async (request: { includeActivityCoverage?: boolean }) => ({
        ...emptyPayload(),
        activityCoverage: request?.includeActivityCoverage
          ? {
              overall: { sessionCount: 0 },
              staleSessionCount: 0,
              unrecognizedFormulaSessionCount: 0,
            }
          : undefined,
      })
    );
    render(<DiagnosticsLegacyBody />);
    await screen.findByRole("tab", { name: "Repos" });
    await waitFor(() =>
      expect(getDiagnostics).toHaveBeenLastCalledWith({
        includeActivityCoverage: false,
      })
    );

    selectTab(WITHHELD_TAB_LABEL);
    await waitFor(() => expect(isSelected(WITHHELD_TAB_LABEL)).toBe(true));
    await expectActiveSection("withheld-section");

    selectTab(COVERAGE_TAB_LABEL);
    await waitFor(() => expect(isSelected(COVERAGE_TAB_LABEL)).toBe(true));
    await waitFor(() =>
      expect(getDiagnostics).toHaveBeenLastCalledWith({
        includeActivityCoverage: true,
      })
    );
    await expectActiveSection("coverage-section");
    expect(
      within(activePanel())
        .getByTestId("coverage-section")
        .getAttribute("data-coverage")
    ).toBe("present");
  });
});

describe("DiagnosticsLegacyBody — error handling and Refresh", () => {
  it("shows the load error and re-requests on Refresh", async () => {
    const getDiagnostics = vi
      .fn()
      .mockRejectedValueOnce(new Error("db locked"))
      .mockResolvedValue(emptyPayload());
    installDiagnosticsApi(getDiagnostics);
    render(<DiagnosticsLegacyBody />);

    expect(await screen.findByText("db locked")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(getDiagnostics).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("db locked")).toBeNull());
  });
});

describe("DiagnosticsLegacyBody — Pause/Resume auto-refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops polling once paused and resumes once Resume is clicked", async () => {
    vi.useFakeTimers();
    const getDiagnostics = installDiagnosticsApi(async () => emptyPayload());
    render(<DiagnosticsLegacyBody />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getDiagnostics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(getDiagnostics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getDiagnostics.mock.calls.length).toBeGreaterThan(1);
  });
});
