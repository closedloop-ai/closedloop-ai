/**
 * ISS-10492 — the fold that decides whether the ambient analysis bar belongs on
 * screen, and which of its numbers may be stated.
 */

import {
  OnboardingPhase,
  type OnboardingPhase as OnboardingPhaseValue,
} from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import {
  type OnboardingAnalysisProgress,
  OnboardingAnalysisProgressStatus,
  type OnboardingSessionDiscovery,
  type OnboardingSessionSource,
} from "../../components/guided-onboarding-data";
import {
  deriveAnalysisBannerInputs,
  isAnalysisStatusPhase,
  OnboardingRunStanding,
  resolveAnalysisBannerInputs,
} from "../onboarding-analysis-banner-inputs";

const RUNNING: OnboardingAnalysisProgress = {
  percent: 40,
  status: OnboardingAnalysisProgressStatus.Measured,
};

const MEASURED_DISCOVERY: OnboardingSessionDiscovery = {
  estimate: { status: "unknown" },
  logBytes: null,
  sessionsAnalyzed: 120,
  sessionsFound: 300,
  sources: [],
  status: "measured",
};

/**
 * The classification this suite pins, restated INDEPENDENTLY of the production
 * record so that flipping a row there reddens here rather than agreeing with
 * itself. Exhaustive over the phase union for the same reason the production
 * record is: a phase added to the machine fails `tsc` in both places.
 */
const EXPECTED_ANALYSIS_PHASE = {
  [OnboardingPhase.Welcome]: false,
  [OnboardingPhase.SessionDiscovery]: false,
  [OnboardingPhase.Account]: true,
  [OnboardingPhase.CreateOrganization]: true,
  [OnboardingPhase.ChooseOrganization]: true,
  // ISS-10890: Welcome's Start is the agreement, and the sync-policy step now
  // follows the organization step, so the bar reports agreed analysis there.
  [OnboardingPhase.SyncPolicy]: true,
  [OnboardingPhase.DownloadDesktop]: false,
  [OnboardingPhase.InviteTeam]: true,
  [OnboardingPhase.ConnectGitHub]: true,
  [OnboardingPhase.DashboardAvailable]: true,
  [OnboardingPhase.DashboardTour]: true,
  [OnboardingPhase.Ready]: true,
} as const satisfies Record<OnboardingPhaseValue, boolean>;

function derive(
  overrides: Partial<Parameters<typeof deriveAnalysisBannerInputs>[0]> = {}
) {
  return deriveAnalysisBannerInputs({
    discovery: MEASURED_DISCOVERY,
    phase: OnboardingPhase.Ready,
    progress: RUNNING,
    settled: false,
    ...overrides,
  });
}

describe("deriveAnalysisBannerInputs", () => {
  it("classifies every onboarding phase, the two the prototype never reached included", () => {
    for (const [phase, expected] of Object.entries(EXPECTED_ANALYSIS_PHASE) as [
      OnboardingPhaseValue,
      boolean,
    ][]) {
      expect([phase, isAnalysisStatusPhase(phase)]).toEqual([phase, expected]);
      expect([phase, derive({ phase }).active]).toEqual([phase, expected]);
    }
  });

  it("stays inactive before a run has been read at all", () => {
    expect(derive({ phase: undefined }).active).toBe(false);
  });

  it("withdraws the bar once the host's import settles, even below 100%", () => {
    // A pass that quarantines sources reaches a terminal at, say, 40%. Without
    // this axis the bar sweeps forever claiming analysis is still running.
    expect(derive({ settled: true }).active).toBe(false);
    expect(derive({ settled: false }).active).toBe(true);
  });

  it("withdraws the bar at 100% and keeps it just below", () => {
    expect(derive({ progress: { ...RUNNING, percent: 100 } }).active).toBe(
      false
    );
    expect(derive({ progress: { ...RUNNING, percent: 99.9 } }).active).toBe(
      true
    );
  });

  it("treats an unmeasured percentage as inactive rather than a sweeping claim", () => {
    const inputs = derive({
      progress: { status: OnboardingAnalysisProgressStatus.Unknown },
    });
    expect(inputs.active).toBe(false);
    expect(inputs.percent).toBeNull();
  });

  // ISS-11668 ruling 16: the first frame states "X / Y", so the bar waits for
  // the analyzed count wherever discovery counted sessions.
  it("waits for the analyzed count wherever discovery counted sessions", () => {
    expect(
      derive({ discovery: { ...MEASURED_DISCOVERY, sessionsAnalyzed: null } })
        .active
    ).toBe(false);
    expect(derive({ discovery: { status: "unknown" } }).active).toBe(false);
    // Measured on its estimate alone: the inventory has not reported yet.
    expect(
      derive({
        discovery: {
          ...MEASURED_DISCOVERY,
          logBytes: null,
          sessionsAnalyzed: null,
          sessionsFound: null,
        },
      }).active
    ).toBe(false);
  });

  // Operator ruling, 2026-10-02: where discovery counts nothing (Cursor or
  // Copilot only), the bar shows without a counter rather than not at all.
  it("goes active without a counter where discovery counts no sessions", () => {
    expect(
      derive({
        discovery: {
          ...MEASURED_DISCOVERY,
          logBytes: 0,
          sessionsAnalyzed: null,
          sessionsFound: null,
        },
      })
    ).toMatchObject({ active: true, analyzed: null, found: null });
  });

  it("carries the measured counts through and never defaults an absent one", () => {
    expect(derive()).toMatchObject({
      analyzed: 120,
      found: 300,
      percent: 40,
    });
    expect(
      derive({
        discovery: {
          ...MEASURED_DISCOVERY,
          sessionsAnalyzed: null,
          sessionsFound: null,
        },
      })
    ).toMatchObject({ analyzed: null, found: null });
    expect(derive({ discovery: { status: "unknown" } })).toMatchObject({
      analyzed: null,
      found: null,
    });
  });

  it("keeps a measured zero distinct from an unmeasured count", () => {
    expect(
      derive({ discovery: { ...MEASURED_DISCOVERY, sessionsAnalyzed: 0 } })
        .analyzed
    ).toBe(0);
  });

  /**
   * ISS-10582. The banner states its two counts as a bare "X / Y" with no
   * labels, so the pair reads as a fraction. A store that has outlived its
   * transcripts holds more rows than the disk has files, and stating the pair
   * there would render "2,443 / 940" — 260% of its own denominator.
   */
  it("withholds both counts when a source's analyzed count overshoots its found count", () => {
    const inputs = derive({
      discovery: {
        ...MEASURED_DISCOVERY,
        sessionsAnalyzed: 2443,
        sessionsFound: 940,
        sources: [detectedSource(2443, 940)],
      },
    });

    expect(inputs).toMatchObject({ analyzed: null, found: null });
    // The bar itself is untouched — only the counter pair is withheld.
    expect(inputs.percent).toBe(40);
  });

  it("withholds both counts for a per-source overshoot that the two totals hide", () => {
    expect(
      derive({
        discovery: {
          ...MEASURED_DISCOVERY,
          // 2443 sits inside 5940 once summed, so a check on the totals alone
          // would state the pair while the claude row overshoots by 1,503.
          sessionsAnalyzed: 2443,
          sessionsFound: 5940,
          sources: [detectedSource(2443, 940), detectedSource(0, 5000)],
        },
      })
    ).toMatchObject({ analyzed: null, found: null });
  });

  it("states both counts when every source's analyzed count fits", () => {
    expect(
      derive({
        discovery: {
          ...MEASURED_DISCOVERY,
          sessionsAnalyzed: 500,
          sessionsFound: 940,
          sources: [detectedSource(500, 940)],
        },
      })
    ).toMatchObject({ analyzed: 500, found: 940 });
  });
});

describe("resolveAnalysisBannerInputs", () => {
  /** A host pass mid-run, distinguishable from anything the fold derives. */
  const OVERRIDE = {
    active: true,
    analyzed: 545,
    found: 7974,
    label: "Processing agent history",
    percent: 6,
  };

  function resolve(
    phase: OnboardingPhase | undefined,
    override = OVERRIDE,
    history: OnboardingPhase[] = [],
    runStanding: OnboardingRunStanding = OnboardingRunStanding.Read
  ) {
    return resolveAnalysisBannerInputs({
      discovery: MEASURED_DISCOVERY,
      history,
      override,
      phase,
      progress: RUNNING,
      runStanding,
      settled: false,
    });
  }

  // ISS-10950: the screen that ASKS for the analysis. An override that wins
  // here is the filed bug — a bar reporting 545 of 7,974 source files behind a
  // modal whose button says analysis has not started.
  it("suppresses an active host override during welcome", () => {
    const resolved = resolve(OnboardingPhase.Welcome);
    expect(resolved).toMatchObject({ active: false });
    // Not merely inactive — the override is not what came back at all, so
    // nothing of the host pass reaches the bar on this screen.
    expect(resolved).not.toHaveProperty("label");
  });

  it.each([true, false])(
    "hides early sync progress before Discovery, with host active=%s",
    (active) => {
      expect(
        resolve(OnboardingPhase.SyncPolicy, { ...OVERRIDE, active }, [
          OnboardingPhase.Welcome,
        ])
      ).toMatchObject({ active: false });
    }
  );

  it.each([true, false])(
    "shows late sync progress after Discovery, with host active=%s",
    (active) => {
      expect(
        resolve(OnboardingPhase.SyncPolicy, { ...OVERRIDE, active }, [
          OnboardingPhase.Welcome,
          OnboardingPhase.SessionDiscovery,
          OnboardingPhase.Account,
          OnboardingPhase.CreateOrganization,
        ])
      ).toMatchObject({ active: true });
    }
  );

  it("hands the host override through on a phase that shows the bar", () => {
    expect(resolve(OnboardingPhase.Account)).toBe(OVERRIDE);
  });

  // Discovery owns its progress until Continue advances past the screen.
  it("hides ambient progress until Continue leaves session discovery", () => {
    expect(resolve(OnboardingPhase.SessionDiscovery)).toMatchObject({
      active: false,
    });
    expect(resolve(OnboardingPhase.Account)).toBe(OVERRIDE);
  });

  // AC5: after the wizard exits there is no phase, and the bar is the ambient
  // one that reappears on nearly every login.
  it("hands the host override through once no run holds a phase", () => {
    expect(resolve(undefined)).toBe(OVERRIDE);
  });

  // ISS-11279 — the reported defect. The desktop startup pass goes active 350ms
  // after boot while the run is still being read, and an absent phase used to be
  // read as "the wizard exited", so the bar drew itself in from the top over a
  // dashboard whose takeover had not painted its first screen yet.
  it("suppresses an active host override while the run is unread", () => {
    const resolved = resolve(
      undefined,
      OVERRIDE,
      [],
      OnboardingRunStanding.Unread
    );
    expect(resolved).toMatchObject({ active: false });
    // Not merely inactive: none of the host pass reaches the bar, so it cannot
    // state a label or a count for a screen the reader has not been shown.
    expect(resolved).not.toHaveProperty("label");
  });

  // The other half of that distinction, and the one that must NOT suppress:
  // ISS-10492 made this bar the desktop's only startup-progress surface, so a
  // reader whose run read failed still has to see the pass they are waiting on.
  it("hands the host override through once the run is known absent", () => {
    expect(resolve(undefined, OVERRIDE, [], OnboardingRunStanding.Absent)).toBe(
      OVERRIDE
    );
  });

  // The derived fallback is gated by the same standing, so a host with no
  // override cannot leak an analysis claim through the unread window either.
  it("suppresses the derived bar while the run is unread", () => {
    expect(
      resolve(
        OnboardingPhase.Account,
        { ...OVERRIDE, active: false },
        [],
        OnboardingRunStanding.Unread
      )
    ).toMatchObject({ active: false });
  });

  it("falls back to the derived inputs when the host reports no pass", () => {
    expect(
      resolve(OnboardingPhase.Account, { ...OVERRIDE, active: false })
    ).toMatchObject({ active: true, analyzed: 120, found: 300 });
  });

  // ISS-11668 ruling 15: a sync's exit frames keep the sync's own counter
  // instead of the finished parse's 120 / 300.
  it("keeps the host's own frame through its exit when the derived pass is not on screen", () => {
    const syncExit = { active: false, analyzed: 10, found: 10, percent: 100 };
    expect(
      resolveAnalysisBannerInputs({
        discovery: MEASURED_DISCOVERY,
        history: [],
        override: syncExit,
        phase: OnboardingPhase.Account,
        progress: RUNNING,
        settled: true,
      })
    ).toBe(syncExit);
  });

  // An override that states nothing never showed: the derived pass that did
  // still closes on its own final frame.
  it("lets the derived frame close the bar when the host override states nothing", () => {
    expect(
      resolveAnalysisBannerInputs({
        discovery: MEASURED_DISCOVERY,
        history: [],
        override: { active: false, analyzed: null, found: null, percent: null },
        phase: OnboardingPhase.Account,
        progress: RUNNING,
        settled: true,
      })
    ).toMatchObject({ active: false, analyzed: 120, found: 300 });
  });
});

function detectedSource(
  analyzed: number,
  found: number
): OnboardingSessionSource {
  return {
    detection: { analyzed, found, status: "detected" },
    harness: `harness-${found}`,
    label: `Label:${found}`,
  };
}
