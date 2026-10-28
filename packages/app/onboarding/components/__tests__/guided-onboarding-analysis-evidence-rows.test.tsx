// @vitest-environment jsdom

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  foldOnboardingSessionDiscovery,
  OnboardingEnumerationQuality,
} from "../../lib/onboarding-session-discovery";
import {
  OnboardingAnalysisEstimateStatus,
  OnboardingAnalysisProgressStatus,
  type OnboardingSessionDiscovery,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";

/**
 * ISS-11591. The analysis step listed EVERY harness the collector registry
 * scans, so Cursor, Copilot and OpenCode rendered an empty track beside "Not
 * reported" on a machine that had only Claude Code and Codex — three claims a
 * reader cannot tell apart, above the two rows carrying real counts.
 *
 * The rows are now exactly the ones the host holds positive evidence about, so
 * these cases run the PRODUCTION FOLD rather than a hand-built source list: the
 * defect lived in what the fold emitted, and a fixture typed straight into the
 * component would stay green with the fold unchanged.
 */
const NOT_REPORTED = "Not reported";
const CLAUDE_ROW_COUNTS = /131 found\s*·\s*130 analyzed/;
const CODEX_ROW_COUNTS = /6 found\s*·\s*6 analyzed/;
const OVERALL_BAR = "Overall import progress";

describe("the analysis step's source list (ISS-11591)", () => {
  it("lists only the harnesses the host reported, never the ones it did not", () => {
    renderDiscovery(
      foldOnboardingSessionDiscovery({
        absent: [],
        analyzed: [
          { harness: "claude", sessions: 130 },
          { harness: "codex", sessions: 6 },
        ],
        bytes: null,
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
        found: [
          { harness: "claude", sessions: 131 },
          { harness: "codex", sessions: 6 },
        ],
        label: (harness) => HARNESS_LABELS[harness] ?? harness,
        logBytes: 4096,
        quality: OnboardingEnumerationQuality.Whole,
      }).discovery
    );

    expect(screen.getByText(CLAUDE_ROW_COUNTS)).toBeVisible();
    expect(screen.getByText(CODEX_ROW_COUNTS)).toBeVisible();
    expect(sourceBarNames()).toEqual([
      "Claude Code import progress",
      "Codex import progress",
    ]);
    for (const absent of ["Cursor", "Copilot", "OpenCode"]) {
      expect(screen.queryByText(absent)).toBeNull();
    }
    expect(screen.queryByText(NOT_REPORTED)).toBeNull();
  });

  it("keeps a proven-absent harness, which is a different claim", () => {
    // The ISS-8678 evidence rule is untouched: a host that LOOKED and found no
    // Cursor still says so. Only the uninspected row goes.
    renderDiscovery(
      foldOnboardingSessionDiscovery({
        absent: ["cursor"],
        analyzed: [{ harness: "claude", sessions: 3 }],
        bytes: null,
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
        found: [{ harness: "claude", sessions: 3 }],
        label: (harness) => HARNESS_LABELS[harness] ?? harness,
        logBytes: 4096,
        quality: OnboardingEnumerationQuality.Whole,
      }).discovery
    );

    expect(screen.getByText("Cursor")).toBeVisible();
    expect(screen.getByText("Not detected")).toBeVisible();
    expect(screen.queryByText(NOT_REPORTED)).toBeNull();
  });

  it("falls back to the shipped empty state when nothing was reported", () => {
    // The screen the ticket's own empty case needs: already shipped, human
    // written, and reached by a fold that now emits no rows at all.
    renderDiscovery({ status: "unknown" });

    expect(screen.getByText("No session sources reported yet")).toBeVisible();
    expect(
      screen.getByText(
        "Each tool appears here with its own counts once the scan reports them."
      )
    ).toBeVisible();
    expect(sourceBarNames()).toEqual([]);
  });
});

const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** What each SOURCE bar announces, in list order — the summary bar excluded. */
function sourceBarNames(): string[] {
  return screen
    .getAllByRole("progressbar")
    .map((bar) => bar.getAttribute("aria-label") ?? "")
    .filter((name) => name !== OVERALL_BAR);
}

function renderDiscovery(discovery: OnboardingSessionDiscovery) {
  render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      discovery={discovery}
      downloadHrefs={DOWNLOAD_HREFS}
      onComplete={vi.fn()}
      open
      phase={OnboardingPhase.SessionDiscovery}
      progress={{
        percent: 42,
        status: OnboardingAnalysisProgressStatus.Measured,
      }}
    />
  );
}

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;
