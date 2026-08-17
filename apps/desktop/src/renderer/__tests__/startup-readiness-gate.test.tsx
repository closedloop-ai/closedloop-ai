import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY } from "../../shared/desktop-compute-progress-count-flag";
import { DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY } from "../../shared/feature-flags";
import { StartupReadinessBannerGate } from "../App";
import { startupProgressBarName } from "../components/startup-readiness/startup-readiness-progress";
import { StartupReadinessProgressBar } from "../components/startup-readiness/startup-readiness-progress-bar";
import { StartupReadinessPhase } from "../components/startup-readiness/startup-readiness-state";

// Keyed, not a single boolean: this gate reads TWO flags and ISS-6241's defect
// was the compute-count flag being dropped on one of the two branches, which a
// shared boolean could never tell apart.
const flag = vi.hoisted(() => ({ enabled: {} as Record<string, boolean> }));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => flag.enabled[key] === true,
}));

// ISS-6118 retired the `collapsible-import-splash` Labs flag enabled and with
// it `FirstLaunchImportBannerGate`, which existed only to read that flag. The
// splash reads no flags of its own now, so the readiness-flag-off path mounts
// the banner directly and there is no longer a gated/ungated pair to tell
// apart — only that the off path still mounts the splash rather than the panel.
vi.mock("../components/first-launch-import-banner", () => ({
  FirstLaunchImportBanner: ({
    showComputeProgress,
  }: {
    showComputeProgress?: boolean;
  }) => (
    <div
      data-compute-progress={String(showComputeProgress === true)}
      data-testid="legacy-startup-banner"
    >
      Legacy startup
    </div>
  ),
}));

// The panel itself is all polling hooks, so it is stubbed — but the stub mounts
// the REAL global progress bar (a pure, prop-driven component). ISS-5115's
// perceivable change therefore has to satisfy the closed-by-default gate on
// both branches: absent with the flag off, present with it on.
vi.mock("../components/startup-readiness/startup-readiness-panel", () => ({
  StartupReadinessPanel: ({
    showComputeProgress,
  }: {
    showComputeProgress?: boolean;
  }) => (
    <div
      data-compute-progress={String(showComputeProgress === true)}
      data-testid="startup-readiness-panel"
    >
      Readiness
      <StartupReadinessProgressBar
        paused={false}
        phase={StartupReadinessPhase.CheckingHistory}
      />
    </div>
  ),
}));

describe("StartupReadinessBannerGate", () => {
  afterEach(() => {
    cleanup();
    flag.enabled = {};
  });

  it("preserves the existing banner while the flag is off", () => {
    render(<StartupReadinessBannerGate />);

    expect(screen.queryByTestId("legacy-startup-banner")).not.toBeNull();
    expect(screen.queryByTestId("startup-readiness-panel")).toBeNull();
    expect(
      screen.queryByRole("progressbar", {
        name: startupProgressBarName("Checking local history"),
      })
    ).toBeNull();
  });

  it("mounts the ordered readiness experience when opted in", () => {
    flag.enabled[DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY] = true;
    render(<StartupReadinessBannerGate />);

    expect(screen.queryByTestId("legacy-startup-banner")).toBeNull();
    expect(screen.queryByTestId("startup-readiness-panel")).not.toBeNull();
    expect(
      screen.queryByRole("progressbar", {
        name: startupProgressBarName("Checking local history"),
      })
    ).not.toBeNull();
  });

  // ISS-6241 (wongk review): the compute-count toggle must not read as ON while
  // the mounted surface names no population. Whichever surface this gate picks,
  // the flag reaches it.
  it("passes the compute-count flag to the readiness panel when both are on", () => {
    flag.enabled[DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY] = true;
    flag.enabled[DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY] = true;
    render(<StartupReadinessBannerGate />);

    expect(
      screen
        .getByTestId("startup-readiness-panel")
        .getAttribute("data-compute-progress")
    ).toBe("true");
  });

  it("leaves the readiness panel countless when only the readiness flag is on", () => {
    flag.enabled[DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY] = true;
    render(<StartupReadinessBannerGate />);

    expect(
      screen
        .getByTestId("startup-readiness-panel")
        .getAttribute("data-compute-progress")
    ).toBe("false");
  });

  it("passes the compute-count flag to the splash when the readiness flag is off", () => {
    flag.enabled[DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY] = true;
    render(<StartupReadinessBannerGate />);

    expect(
      screen
        .getByTestId("legacy-startup-banner")
        .getAttribute("data-compute-progress")
    ).toBe("true");
  });
});
