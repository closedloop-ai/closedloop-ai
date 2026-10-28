// @vitest-environment jsdom

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY } from "@repo/api/src/types/onboarding-source-ratio-unavailable-flag";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../shared/feature-flags/static-feature-flag-adapter";
import {
  FIXTURE_OVERSHOT_SOURCE,
  FIXTURE_WITHHELD_RATIO_DISCOVERY,
} from "../../lib/guided-onboarding-fixtures";
import {
  ANALYZED_UNAVAILABLE_LABEL,
  EXPLAINED_STATUS_CLASS,
  RATIO_UNAVAILABLE_LABEL,
  SHIPPED_STATUS_CLASS,
} from "../guided-onboarding-analysis-step";
import {
  OnboardingAnalysisEstimateStatus,
  OnboardingAnalysisProgressStatus,
  type OnboardingSessionDiscovery,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";

/**
 * ISS-10961. A source row whose analyzed count OVERSHOOTS its found count has
 * settled: no quotient is coming, and ISS-10582 already ruled that both counts
 * survive and only the ratio is withheld. What shipped in desktop 0.17.133 left
 * that row indistinguishable from one still being scanned — same hatch, same
 * neutral tone, same accessible name — with a travelling sheen as the ONLY
 * difference, which `prefers-reduced-motion` removes and which no screen reader
 * ever had.
 *
 * The fixtures below are the reporter's own machine: Claude Code at 68 found
 * against 72 analyzed, beside a Codex row that divides cleanly. A one-row
 * fixture cannot prove any of this — the defect IS the contrast between rows —
 * so every assertion here runs against a render carrying an overshot row, a
 * measurable row and a completed row at once.
 */
const CLAUDE_BAR_PROGRESS = "Claude Code import progress";
const CLAUDE_BAR_UNAVAILABLE = "Claude Code percentage unavailable";
const CLAUDE_BAR_COUNT_UNAVAILABLE = "Claude Code analyzed count unavailable";
const CODEX_BAR_PROGRESS = "Codex import progress";
const CURSOR_BAR_PROGRESS = "Cursor import progress";
/** The summary bar over the list, which is not one of the source rows. */
const OVERALL_BAR = "Overall import progress";
/** The leading glyph every NON-withheld detected row renders. */
const DETECTED_GLYPH = "svg.lucide-circle";
/** The row's own counts, which this change may not take away (ISS-10582). */
const OVERSHOT_ROW_COUNTS = /68 found\s*·\s*72 analyzed/;
const MEASURED_ROW_COUNTS = /7,781 found\s*·\s*7,744 analyzed/;
/** The row whose read came back unusable: the count went with the ratio. */
const UNUSABLE_ROW_COUNTS = /68 found\s*·\s*Analyzed count unavailable/;
const SHEEN = "[data-slot='progress-sheen']";
const WITHHELD_GLYPH = "svg.lucide-circle-slash";

describe("a source row whose analyzed count overshoots its found count", () => {
  it("names the unavailable percentage, keeps both counts, and leaves its measurable siblings alone", () => {
    renderDiscovery({ enabled: true, discovery: MIXED_SOURCES });

    // AC1 — the shortfall is STATED, in the row's own words, beside the two
    // counts that caused it. Without this the row renders two numbers and says
    // nothing at all about the bar next to them.
    const claude = screen.getByRole("progressbar", {
      name: CLAUDE_BAR_UNAVAILABLE,
    });
    expect(screen.getByText(OVERSHOT_ROW_COUNTS).textContent).toContain(
      RATIO_UNAVAILABLE_LABEL
    );
    // ...and it reaches the ACCESSIBILITY TREE, not only the pixels. The bar no
    // longer answers to "import progress", which is what made a held bar and a
    // sweeping one announce identically.
    expect(
      screen.queryByRole("progressbar", { name: CLAUDE_BAR_PROGRESS })
    ).toBeNull();
    // Settled, not in flight: no travelling sheen. Paired with the positive
    // above so a row that rendered nothing could not satisfy this.
    expect(claude.querySelector(SHEEN)).toBeNull();
    // The sighted half of the same statement, by SHAPE rather than hue — the
    // muted tone is shared with a row that is merely undetected.
    expect(rowOf(claude).querySelector(WITHHELD_GLYPH)).not.toBeNull();

    // AC2 — the measurable sibling is untouched: still named for progress,
    // still a determinate fill, and it does not borrow the unavailable wording.
    const codex = screen.getByRole("progressbar", { name: CODEX_BAR_PROGRESS });
    expect(codex.getAttribute("data-state")).not.toBe("indeterminate");
    expect(codex.getAttribute("aria-valuenow")).toBe("99");
    expect(screen.getByText(MEASURED_ROW_COUNTS).textContent).not.toContain(
      RATIO_UNAVAILABLE_LABEL
    );
    expect(rowOf(codex).querySelector(WITHHELD_GLYPH)).toBeNull();

    // AC2 again, at the other end: a row that genuinely finished still reads as
    // finished rather than being swept into the unavailable treatment.
    const cursor = screen.getByRole("progressbar", {
      name: CURSOR_BAR_PROGRESS,
    });
    expect(cursor.getAttribute("aria-valuenow")).toBe("100");
    expect(rowOf(cursor).querySelector(WITHHELD_GLYPH)).toBeNull();

    // And the list carries exactly ONE withheld row. The contrast is the whole
    // complaint, so "settle the withheld row" must not be satisfiable by
    // settling every row, nor by settling none — this reads what the three bars
    // actually announce, in list order, rather than that they are three nodes.
    expect(sourceBarNames()).toEqual([
      CLAUDE_BAR_UNAVAILABLE,
      CODEX_BAR_PROGRESS,
      CURSOR_BAR_PROGRESS,
    ]);
  });

  it("still sweeps a source whose analyzed count is merely unread, and says nothing unavailable about it", () => {
    // The positive control for "without suggesting an in-flight scan". A store
    // that has not been read IS a measurement in flight, so that row must keep
    // the progress vocabulary — otherwise "settle the withheld row" could be
    // implemented by settling every row and the test above would still pass.
    renderDiscovery({ enabled: true, discovery: UNREAD_SOURCES });

    const claude = screen.getByRole("progressbar", {
      name: CLAUDE_BAR_PROGRESS,
    });
    expect(claude.querySelector(SHEEN)).not.toBeNull();
    expect(rowOf(claude).querySelector(WITHHELD_GLYPH)).toBeNull();
    expect(screen.queryByText(RATIO_UNAVAILABLE_LABEL)).toBeNull();
    expect(
      screen.queryByRole("progressbar", { name: CLAUDE_BAR_UNAVAILABLE })
    ).toBeNull();
  });

  it("presents the settled state on the FIRST paint of a rehydrated launch, with no update to arrive", () => {
    // AC3. Reopening Desktop re-reads the counts out of `agent-dashboard.sqlite`
    // and mounts the step with the overshoot already present — nothing animates
    // in, nothing transitions. So the unavailable state has to be legible from
    // the initial render alone; if it depended on an update the screen would
    // reopen looking exactly like a scan that had not started.
    renderDiscovery({ enabled: true, discovery: RESTORED_OVERSHOOT });

    const claude = screen.getByRole("progressbar", {
      name: CLAUDE_BAR_UNAVAILABLE,
    });
    expect(claude.querySelector(SHEEN)).toBeNull();
    expect(rowOf(claude).querySelector(WITHHELD_GLYPH)).not.toBeNull();
    expect(screen.getByText(OVERSHOT_ROW_COUNTS).textContent).toContain(
      RATIO_UNAVAILABLE_LABEL
    );
    // The in-flight vocabulary is absent from the whole screen on this mount,
    // so nothing here can read as a scan awaiting progress.
    expect(
      screen.queryByRole("progressbar", { name: CLAUDE_BAR_PROGRESS })
    ).toBeNull();
  });

  it("names the shortfall the row actually states when the analyzed count went with it", () => {
    // The OTHER withheld shortfall. A read that came back unusable takes the
    // count with it, so the row's words say the analyzed count is missing — and
    // the bar must say the same thing. Naming a missing PERCENTAGE over a row
    // that never mentions one puts two different accounts of the same failure
    // on one line, which the presentation object exists to prevent.
    renderDiscovery({ enabled: true, discovery: UNUSABLE_READ });

    const claude = screen.getByRole("progressbar", {
      name: CLAUDE_BAR_COUNT_UNAVAILABLE,
    });
    expect(claude.querySelector(SHEEN)).toBeNull();
    expect(rowOf(claude).querySelector(WITHHELD_GLYPH)).not.toBeNull();
    expect(screen.getByText(UNUSABLE_ROW_COUNTS).textContent).toContain(
      ANALYZED_UNAVAILABLE_LABEL
    );
    // The percentage wording belongs to the row that still HAS both counts.
    expect(screen.queryByText(RATIO_UNAVAILABLE_LABEL)).toBeNull();
    expect(
      screen.queryByRole("progressbar", { name: CLAUDE_BAR_UNAVAILABLE })
    ).toBeNull();
  });

  it("renders exactly what shipped while the gate is closed", () => {
    // ISS-4779 closed-by-default. Off, the row is byte-identical to 0.17.133 —
    // which is also why the desktop e2e suite needs no edit for this change.
    renderDiscovery({ enabled: false, discovery: MIXED_SOURCES });

    const claude = screen.getByRole("progressbar", {
      name: CLAUDE_BAR_PROGRESS,
    });
    const status = screen.getByText(OVERSHOT_ROW_COUNTS);
    expect(status.textContent).not.toContain(RATIO_UNAVAILABLE_LABEL);
    expect(rowOf(claude).querySelector(WITHHELD_GLYPH)).toBeNull();
    expect(
      screen.queryByRole("progressbar", { name: CLAUDE_BAR_UNAVAILABLE })
    ).toBeNull();
    // The shipped SIDE, not only the absence of the new one: the glyph that
    // does render, and the status column's own geometry. Without these the case
    // would stay green if the gate leaked the widened track or the settled mark
    // into the closed branch, which is the half of "byte-identical" that an
    // absence assertion cannot reach.
    expect(rowOf(claude).querySelector(DETECTED_GLYPH)).not.toBeNull();
    expect(status.className).toBe(SHIPPED_STATUS_CLASS);
    expect(status.className).not.toBe(EXPLAINED_STATUS_CLASS);
    // And every row in the list keeps the shipped progress vocabulary.
    expect(sourceBarNames()).toEqual([
      CLAUDE_BAR_PROGRESS,
      CODEX_BAR_PROGRESS,
      CURSOR_BAR_PROGRESS,
    ]);
  });
});

/** The three-row contrast, shared with the Storybook story. */
const MIXED_SOURCES = FIXTURE_WITHHELD_RATIO_DISCOVERY;

/** Every row's analyzed count still unread — a scan genuinely in flight. */
const UNREAD_SOURCES: OnboardingSessionDiscovery = {
  estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
  logBytes: 8192,
  sessionsAnalyzed: null,
  sessionsFound: 68,
  sources: [
    {
      detection: { analyzed: null, found: 68, status: "detected" },
      harness: "claude",
      label: "Claude Code",
    },
  ],
  status: "measured",
};

/** The overshoot alone, as a relaunch re-reads it out of the local store. */
const RESTORED_OVERSHOOT: OnboardingSessionDiscovery = {
  estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
  logBytes: 8192,
  sessionsAnalyzed: 72,
  sessionsFound: 68,
  sources: [FIXTURE_OVERSHOT_SOURCE],
  status: "measured",
};

/** A read that came back unusable: the analyzed count went with the ratio. */
const UNUSABLE_READ: OnboardingSessionDiscovery = {
  estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
  logBytes: 8192,
  sessionsAnalyzed: null,
  sessionsFound: 68,
  sources: [
    {
      detection: {
        analyzed: null,
        analyzedWithheld: true,
        found: 68,
        status: "detected",
      },
      harness: "claude",
      label: "Claude Code",
    },
  ],
  status: "measured",
};

/** What each SOURCE bar announces, in list order — the summary bar excluded. */
function sourceBarNames(): string[] {
  return screen
    .getAllByRole("progressbar")
    .map((bar) => bar.getAttribute("aria-label") ?? "")
    .filter((name) => name !== OVERALL_BAR);
}

/** The grid container holding one source's glyph, bar and counts. */
function rowOf(bar: HTMLElement): HTMLElement {
  const row = bar.parentElement;
  if (row === null) {
    throw new Error("source bar is not inside a row");
  }
  return row;
}

function renderDiscovery({
  discovery,
  enabled,
}: {
  discovery: OnboardingSessionDiscovery;
  enabled: boolean;
}) {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled
          ? [ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY]
          : [],
      })}
    >
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        discovery={discovery}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SessionDiscovery}
        progress={{
          percent: 99,
          status: OnboardingAnalysisProgressStatus.Measured,
        }}
      />
    </FeatureFlagAdapterProvider>
  );
}

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;
