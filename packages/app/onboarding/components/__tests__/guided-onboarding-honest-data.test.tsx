// @vitest-environment jsdom

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KPI_NO_VALUE } from "../../../shared/lib/format-utils";
import {
  FIXTURE_ACCOUNT,
  FIXTURE_FIRST_MEMBER,
  FIXTURE_JOINABLE_ORGANIZATION,
  FIXTURE_ORGANIZATION_MEMBERS,
  FIXTURE_ORGANIZATION_NAME,
  FIXTURE_SESSION_DISCOVERY,
  measuredAnalysisProgress,
  UNWIRED_GUIDED_ONBOARDING_DATA,
  type UnwiredOnboardingField,
} from "../../lib/guided-onboarding-fixtures";
import { ANALYZED_UNAVAILABLE_LABEL } from "../guided-onboarding-analysis-step";
import {
  OnboardingAnalysisEstimateStatus,
  OnboardingAnalysisProgressStatus,
  OnboardingDesktopSkipEligibility,
  OnboardingProgressOperand,
  type OnboardingSessionDiscovery,
  UNKNOWN_ANALYSIS_PROGRESS,
  UNKNOWN_SESSION_DISCOVERY,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import type { GuidedOnboardingDialogProps } from "../guided-onboarding-types";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

const TICKET_SLUG = /^ISS-\d+$/;
const SESSIONS_FOUND = /sessions found/;
// Deliberate copies of the step's own headings, as a trip-wire ON TOP of the
// heading coverage that locates through the component. A completion claim over
// a withheld ratio is the ISS-10582 defect itself, so it is pinned by the words.
const ANALYSIS_COMPLETE_HEADING = "Session analysis complete.";
const ANALYSIS_STARTED_HEADING = "Session analysis started.";
/** The ISS-10582 row: both counts, each beside its own label. */
const OVERSHOT_ROW_COUNTS = /940 found\s*·\s*2,443 analyzed/;
const EXISTING_MEMBER_CLAIM = /people at your company already use Closedloop/;
const SIZE_OR_DURATION = /\d+(\.\d+)?\s(B|KB|MB|GB)|\d+\sminutes?/;
const ANALYSIS_COMPLETE_CLAIM = /Session analysis complete\./;
const BYTE_SIZE_CLAIM = /\d+(\.\d+)?\s(B|KB|MB|GB)\sof logs/;
const DURATION_CLAIM = /estimated to take/;
const PERCENT_CAPTION = /^\d+%$/;
const ANALYZED_COUNT = /analyzed$/;
const ZERO_MINUTE_ESTIMATE = /estimated to take 0 minutes/;
const ONE_MINUTE_ESTIMATE = /estimated to take 1 minute\./;

const SESSIONS_ANALYZED_CLAIM = /have been analyzed/;
const SCAN_ACTIVITY_CLAIM = /We're analyzing/;
const UNNAMED_COMPANY_SENTENCE =
  /You're the first person from your company to join Closedloop\./;
const INFERRED_COMPANY_SENTENCE = new RegExp(
  `You're the first person from ${FIXTURE_ORGANIZATION_NAME} to join Closedloop\\.`
);
const EMAIL_DOMAIN_COPY = /email domain/i;

/**
 * ISS-8678. Every value the wizard presents as measured — counts, byte totals,
 * durations, per-source progress, detection state, a person, a company — must
 * come from a prop or render an explicit unknown. It shipped inventing all of
 * them, including a real person's email address.
 *
 * Each absence assertion here is PAIRED with a positive control that drives the
 * same query with data supplied. On its own, "the invented string is absent"
 * passes trivially in a component that renders nothing at all.
 */

/** The fixture's measured arm, narrowed by check rather than by cast. */
function measuredFixture(): Extract<
  OnboardingSessionDiscovery,
  { status: "measured" }
> {
  if (FIXTURE_SESSION_DISCOVERY.status !== "measured") {
    throw new Error("FIXTURE_SESSION_DISCOVERY is expected to be measured");
  }
  return FIXTURE_SESSION_DISCOVERY;
}

describe("guided onboarding measured-data honesty", () => {
  it("says the session count is unavailable rather than inventing one", () => {
    renderDialog({
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(40),
    });

    // Positive control: the step really did render, and it is live.
    expect(
      screen
        .getByRole("progressbar", { name: "Overall import progress" })
        .getAttribute("aria-valuenow")
    ).toBe("40");

    expect(screen.getByText("Session count unavailable")).not.toBeNull();
    expect(screen.getByText("No session sources reported yet")).not.toBeNull();
    expect(screen.queryByText(SESSIONS_FOUND)).toBeNull();
    expect(
      screen.queryByRole("progressbar", { name: "Claude Code import progress" })
    ).toBeNull();
  });

  it("states the counts once a scan reports them", () => {
    renderDialog({
      discovery: FIXTURE_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(40),
    });

    expect(screen.getByText("270 sessions found")).not.toBeNull();
    expect(screen.queryByText("Session count unavailable")).toBeNull();
    expect(
      screen.getByRole("progressbar", { name: "Claude Code import progress" })
    ).not.toBeNull();
  });

  it("derives per-source progress from the analyzed and found counts", () => {
    // The shipped code multiplied the OVERALL progress by 1.04 and 2.1 to fake
    // these two bars. At progress=40 that produced 42% and 84%; the real ratios
    // are 252/252 and 9/18. A stand-in factor cannot reproduce both.
    renderDialog({
      discovery: FIXTURE_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(40),
    });

    expect(
      screen
        .getByRole("progressbar", { name: "Claude Code import progress" })
        .getAttribute("aria-valuenow")
    ).toBe("100");
    expect(
      screen
        .getByRole("progressbar", { name: "Codex import progress" })
        .getAttribute("aria-valuenow")
    ).toBe("50");
  });

  it("omits size and duration from the copy until they are measured", () => {
    const { unmount } = renderDialog({
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(40),
    });
    expect(screen.queryByText(SIZE_OR_DURATION)).toBeNull();
    unmount();

    renderDialog({
      discovery: FIXTURE_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(40),
    });
    expect(screen.getByText(SIZE_OR_DURATION)).not.toBeNull();
  });

  it("makes no completion claim about sessions the scan never reported", () => {
    // `progress` measures the IMPORT and `discovery` measures the SCAN. At
    // progress=100 with an unknown scan the step announced "Session analysis
    // complete." and said the sessions had been analyzed — a completion claim
    // over a population nobody had counted.
    const { unmount } = renderDialog({
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(100),
    });

    // Positive control: the step really is in its finished-import state.
    expect(
      screen
        .getByRole("progressbar", { name: "Overall import progress" })
        .getAttribute("aria-valuenow")
    ).toBe("100");

    expect(screen.queryByText(ANALYSIS_COMPLETE_CLAIM)).toBeNull();
    expect(screen.queryByText(SESSIONS_ANALYZED_CLAIM)).toBeNull();
    expect(screen.getByText("Session count unavailable")).not.toBeNull();
    unmount();

    // Paired control: a reported scan at the same progress still says complete,
    // so the assertions above are not passing on a step that renders nothing.
    renderDialog({
      discovery: FIXTURE_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(100),
    });
    expect(screen.getByText(ANALYSIS_COMPLETE_CLAIM)).not.toBeNull();
    expect(screen.getByText(SESSIONS_ANALYZED_CLAIM)).not.toBeNull();
  });

  it("claims no scan is running until the scan reports", () => {
    // The unknown branch also asserted activity ("We're analyzing the agent
    // sessions on this machine") when the host had supplied no evidence that
    // any scan was under way.
    renderDialog({
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(40),
    });
    expect(screen.queryByText(SCAN_ACTIVITY_CLAIM)).toBeNull();
    expect(screen.getByText("No session sources reported yet")).not.toBeNull();
  });

  it("claims no teammates while the membership lookup is unknown", () => {
    renderDialog({ phase: OnboardingPhase.InviteTeam });

    // Positive control: the invite step rendered and offers its real action.
    expect(screen.getByRole("button", { name: "Skip for now" })).not.toBeNull();

    expect(screen.queryByText(EXISTING_MEMBER_CLAIM)).toBeNull();
    expect(screen.queryByText("Sample User")).toBeNull();
  });

  it("names teammates only from a completed membership lookup", () => {
    renderDialog({
      members: FIXTURE_ORGANIZATION_MEMBERS,
      phase: OnboardingPhase.InviteTeam,
    });

    expect(screen.getByText("Sample User")).not.toBeNull();
    expect(screen.getByText(EXISTING_MEMBER_CLAIM)).not.toBeNull();
  });

  it("makes no count claim for an organization known to be empty", () => {
    renderDialog({
      members: FIXTURE_FIRST_MEMBER,
      phase: OnboardingPhase.InviteTeam,
    });

    expect(screen.queryByText(EXISTING_MEMBER_CLAIM)).toBeNull();
    expect(screen.queryByText("Sample User")).toBeNull();
    expect(screen.getByRole("button", { name: "Skip for now" })).not.toBeNull();
  });

  it("shows no address when the signed-in identity is unknown", () => {
    renderDialog({ phase: OnboardingPhase.ChooseOrganization });

    const signedIn = screen.getByText("Signed in");
    expect(signedIn.textContent).not.toContain("@");
  });

  it("shows the address the host supplied", () => {
    renderDialog({
      account: FIXTURE_ACCOUNT,
      phase: OnboardingPhase.ChooseOrganization,
    });

    expect(
      screen.getByText("Signed in as signed-in-user@example.com")
    ).not.toBeNull();
  });

  it("offers no Join affordance until an organization is actually matched", () => {
    renderDialog({ phase: OnboardingPhase.ChooseOrganization });

    // Positive control: the step rendered without borrowing a host action.
    expect(
      screen.getByRole("dialog", { name: "Choose an organization" })
    ).not.toBeNull();

    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
    expect(
      screen.getByText("Checking for organizations you can join")
    ).not.toBeNull();
  });

  it("says so when no authorized organization is ready to join", () => {
    renderDialog({
      joinableOrganization: { status: "none" },
      phase: OnboardingPhase.ChooseOrganization,
    });

    expect(
      screen.getByText("No authorized organization is ready to join")
    ).not.toBeNull();
    expect(screen.queryByText(EMAIL_DOMAIN_COPY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  });

  // ISS-11145: the Join affordance now requires BOTH a `join` target on the row
  // and a host that can honor it, so a control never reports a join nothing
  // performs. The fixture carries the target; the host is supplied here.
  it("names the authorized organization the host supplied", () => {
    renderDialog({
      joinableOrganization: FIXTURE_JOINABLE_ORGANIZATION,
      onJoinOrganization: vi.fn(),
      phase: OnboardingPhase.ChooseOrganization,
    });

    expect(screen.getByText("Example Organization")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Join" })).not.toBeNull();
  });

  it("offers no Join where the host cannot honor one", () => {
    renderDialog({
      joinableOrganization: FIXTURE_JOINABLE_ORGANIZATION,
      phase: OnboardingPhase.ChooseOrganization,
    });

    expect(screen.getByText("Example Organization")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  });

  it("says 'your company' when no company was inferred", () => {
    renderDialog({
      organizationName: "",
      phase: OnboardingPhase.CreateOrganization,
    });

    expect(screen.getByText(UNNAMED_COMPANY_SENTENCE)).not.toBeNull();
  });

  it("names the company the host inferred", () => {
    renderDialog({
      organizationName: FIXTURE_ORGANIZATION_NAME,
      phase: OnboardingPhase.CreateOrganization,
    });

    expect(screen.getByText(INFERRED_COMPANY_SENTENCE)).not.toBeNull();
  });
});

/**
 * ISS-8346 — each measurement behind this step settles independently, so the
 * copy must read honestly when any ONE of them is missing. Every absence
 * assertion below is paired with a positive control driving the same query with
 * that value supplied.
 */
describe("guided onboarding analysis step, partial measurements", () => {
  it("states no duration while the estimate is still calculating", () => {
    const { unmount } = renderDialog({
      discovery: {
        ...measuredFixture(),
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
      },
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(31),
    });

    // The size and count clause still renders; only the duration clause waits.
    expect(screen.getByText(BYTE_SIZE_CLAIM)).not.toBeNull();
    expect(screen.queryByText(DURATION_CLAIM)).toBeNull();
    unmount();

    renderDialog({
      discovery: FIXTURE_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(31),
    });
    expect(screen.getByText(DURATION_CLAIM)).not.toBeNull();
  });

  it("shows no percentage at all when progress is unreported", () => {
    const { unmount } = renderDialog({
      discovery: FIXTURE_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: UNKNOWN_ANALYSIS_PROGRESS,
    });

    // Not "0%", which reads as a measurement of no work done.
    expect(screen.queryByText(PERCENT_CAPTION)).toBeNull();
    expect(
      screen
        .getByRole("progressbar", { name: "Overall import progress" })
        .getAttribute("aria-valuenow")
    ).toBeNull();
    unmount();

    renderDialog({
      discovery: FIXTURE_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(31),
    });
    expect(screen.getByText(PERCENT_CAPTION)).not.toBeNull();
  });

  it("still gates Continue while nothing at all has been reported", () => {
    renderDialog({
      // The analyzer has reported NO inventory — the PRD-689 stalled analyzer,
      // and the one state `canContinueFromDiscovery` still refuses (ISS-10539).
      discovery: UNKNOWN_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(0),
    });

    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("enables Continue on a measured inventory with nothing analyzed yet", () => {
    renderDialog({
      // A settled store read that found none of the 270 discovered sessions
      // analyzed. This USED to disable Continue. It no longer does, and that is
      // a deliberate behavior change, not a relaxed assertion: ISS-10539 ruled a
      // measured inventory to BE the analyzer's first stage reporting, and the
      // machine edge this button fires has accepted it since #7551. Leaving the
      // button disabled here would be the same disagreement whitlockk filed, with
      // the two sides swapped — the screen renders "Session analysis started."
      // off this very discovery.
      discovery: { ...measuredFixture(), sessionsAnalyzed: 0 },
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(0),
    });

    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("obeys a host that has already answered the question itself", () => {
    // THE WHITLOCKK FIX. A host that gates the machine edge hands the button the
    // SAME boolean, so the two cannot disagree. Both directions, because each
    // one alone is satisfied by the derivation this override replaces.
    const { unmount } = renderDialog({
      analysisStarted: false,
      discovery: measuredFixture(),
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(40),
    });
    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")
    ).toBe(true);
    unmount();

    renderDialog({
      analysisStarted: true,
      discovery: UNKNOWN_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: UNKNOWN_ANALYSIS_PROGRESS,
    });
    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("never blocks Continue on a byte lane that has not landed its first bytes (ISS-10624)", () => {
    // THE REGRESSION THIS GUARDS. The percentage can now come from the parse
    // lane, which reads zero on the first poll after a pass opens while the
    // import is already under way. Gating on that would convert a screen that
    // merely LOOKED stuck into one the visitor cannot leave — strictly worse
    // than the bug. The store read here has NOT settled, so nothing has
    // measured that analysis failed to begin.
    renderDialog({
      discovery: { ...measuredFixture(), sessionsAnalyzed: null },
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(0),
    });

    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("lets the visitor continue while progress is still unknown", () => {
    renderDialog({
      discovery: FIXTURE_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: UNKNOWN_ANALYSIS_PROGRESS,
    });

    // The pair to the case above. A measured zero and an absent measurement
    // are different facts: gating on the second makes the wizard unfinishable
    // on any machine whose progress never reports.
    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("never states a zero-minute estimate for a sub-minute one", () => {
    renderDialog({
      discovery: {
        estimate: {
          remainingMinutes: 0.3,
          status: OnboardingAnalysisEstimateStatus.Measured,
        },
        // Bytes and a count, because the duration clause belongs to the
        // design's one sentence and that sentence needs both before it renders.
        logBytes: 4096,
        sessionsAnalyzed: null,
        sessionsFound: 12,
        sources: [],
        status: "measured",
      },
      phase: OnboardingPhase.SessionDiscovery,
      progress: UNKNOWN_ANALYSIS_PROGRESS,
    });

    // "0 minutes" is a completion claim, which is the one thing a MEASURED
    // estimate of eighteen seconds must not turn into.
    expect(screen.queryByText(ZERO_MINUTE_ESTIMATE)).toBeNull();
    expect(screen.getByText(ONE_MINUTE_ESTIMATE)).not.toBeNull();
  });

  it("names a found count without an analyzed one until the store is read", () => {
    renderDialog({
      discovery: {
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
        logBytes: null,
        sessionsAnalyzed: null,
        sessionsFound: 12,
        sources: [
          {
            detection: { analyzed: null, found: 12, status: "detected" },
            harness: "claude",
            label: "Claude Code",
          },
        ],
        status: "measured",
      },
      phase: OnboardingPhase.SessionDiscovery,
      progress: UNKNOWN_ANALYSIS_PROGRESS,
    });

    // "12 found" alone, never "12 found · 0 analyzed": an unread store has
    // analyzed an unknown number, not none.
    expect(screen.getByText("12 found")).not.toBeNull();
    expect(screen.queryByText(ANALYZED_COUNT)).toBeNull();
  });
  it("renders an empty resting track, never an animated one, for a source that is not on the machine", () => {
    renderDialog({
      discovery: FIXTURE_SESSION_DISCOVERY,
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(40),
    });

    // The fixture carries a Cursor row that is proven absent. Every bar on
    // screen is determinate: nothing on this screen is being measured, so
    // nothing may sweep as if work were under way on a tool that is not there.
    expect(screen.getByText("Not detected")).not.toBeNull();
    const bars = screen.getAllByRole("progressbar");
    expect(bars.length).toBe(4);
    for (const bar of bars) {
      expect(bar.getAttribute("data-state")).not.toBe("indeterminate");
    }
  });

  it("names the missing operand and stops sweeping when no lane can state a percentage (ISS-10624)", () => {
    // The operator's screen, 2026-09-17: 1,092 sessions found, every bar an
    // indeterminate sweep for ever, and an em-dash where the percentage goes.
    // The analyzed read was withdrawn as unreconcilable, which is a settled
    // answer — so the screen says so instead of animating work that has stopped.
    renderDialog({
      discovery: {
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
        logBytes: 8192,
        sessionsAnalyzed: null,
        sessionsFound: 1092,
        sources: [
          {
            detection: {
              analyzed: null,
              analyzedWithheld: true,
              found: 946,
              status: "detected",
            },
            harness: "claude",
            label: "Claude Code",
          },
        ],
        status: "measured",
      },
      phase: OnboardingPhase.SessionDiscovery,
      progress: {
        missing: OnboardingProgressOperand.AnalyzedSessions,
        status: OnboardingAnalysisProgressStatus.Unavailable,
      },
    });

    // The shortfall is NAMED where the value would have rendered, and the
    // em-dash — which means "nobody has reported" — is gone. Located through
    // the constant the component renders, never a re-typed copy of it.
    expect(screen.queryByText(KPI_NO_VALUE)).toBeNull();
    expect(
      screen.getAllByText(ANALYZED_UNAVAILABLE_LABEL).length
    ).toBeGreaterThan(0);

    const overall = screen.getByRole("progressbar", {
      name: "Overall import progress",
    });
    // Still indeterminate — we genuinely do not know the amount — but HELD:
    // the sheen is what claims work is advancing, and nothing is.
    expect(overall.getAttribute("data-state")).toBe("indeterminate");
    expect(overall.querySelector("[data-slot='progress-sheen']")).toBeNull();
    const source = screen.getByRole("progressbar", {
      name: "Claude Code import progress",
    });
    expect(source.querySelector("[data-slot='progress-sheen']")).toBeNull();
  });

  it("keeps sweeping a detected source whose analyzed count is merely unread", () => {
    // The positive control for the case above: an unread store IS a measurement
    // in flight, so that row must still animate. Without this, "settle the
    // withdrawn row" could be implemented by settling every row.
    renderDialog({
      discovery: {
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
        logBytes: 8192,
        sessionsAnalyzed: null,
        sessionsFound: 946,
        sources: [
          {
            detection: { analyzed: null, found: 946, status: "detected" },
            harness: "claude",
            label: "Claude Code",
          },
        ],
        status: "measured",
      },
      phase: OnboardingPhase.SessionDiscovery,
      progress: UNKNOWN_ANALYSIS_PROGRESS,
    });

    const source = screen.getByRole("progressbar", {
      name: "Claude Code import progress",
    });
    expect(source.querySelector("[data-slot='progress-sheen']")).not.toBeNull();
    expect(screen.queryByText(ANALYZED_UNAVAILABLE_LABEL)).toBeNull();
  });

  it("holds the bar of a source whose store outlived its transcripts, while still stating its count", () => {
    // ISS-10582, davetho PR #7575 P2/P3. The store's own count is a real read
    // and renders; it is the QUOTIENT that cannot be formed. Deciding "may this
    // bar sweep" from `analyzed === null` swept this row for the life of the
    // screen, claiming active work beside a number it had finished measuring.
    renderDialog({
      discovery: {
        estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
        logBytes: 8192,
        // The numbers measured on the real install in ISS-10582.
        sessionsAnalyzed: 2443,
        sessionsFound: 940,
        sources: [
          {
            detection: {
              analyzed: 2443,
              analyzedWithheld: true,
              found: 940,
              status: "detected",
            },
            harness: "claude",
            label: "Claude Code",
          },
        ],
        status: "measured",
      },
      phase: OnboardingPhase.SessionDiscovery,
      progress: {
        missing: OnboardingProgressOperand.AnalyzedSessions,
        status: OnboardingAnalysisProgressStatus.Unavailable,
      },
    });

    const source = screen.getByRole("progressbar", {
      name: "Claude Code import progress",
    });
    // HELD, not sweeping: the read has settled and no quotient is coming.
    expect(source.querySelector("[data-slot='progress-sheen']")).toBeNull();
    // Both counts still on the ROW, each beside its own label, so nothing
    // invites the reader to divide them.
    expect(screen.getByText(OVERSHOT_ROW_COUNTS)).not.toBeNull();
    // The HEADLINE is where the missing operand is named, because that is the
    // slot the quotient would have filled.
    expect(
      screen.getAllByText(ANALYZED_UNAVAILABLE_LABEL).length
    ).toBeGreaterThan(0);
    // And the producer's byte-lane `complete` may not speak for the session
    // lane: no completion heading over a ratio nobody could form.
    expect(screen.queryByText(ANALYSIS_COMPLETE_HEADING)).toBeNull();
    expect(screen.getByText(ANALYSIS_STARTED_HEADING)).not.toBeNull();
  });

  it("keeps the live bar of a sibling whose own ratio divides while one source is held", () => {
    // ISS-10582, whitlockk PR #7575. The operator's two harnesses on 2026-09-19:
    // `claude` has outlived its transcripts and `codex` has not. Carrying the
    // withheld marker on the whole fold held BOTH bars, reporting a source
    // nothing is wrong with as degraded over its sibling's shortfall.
    renderDialog({
      discovery: {
        estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
        logBytes: 8192,
        sessionsAnalyzed: 2447,
        sessionsFound: 1086,
        sources: [
          {
            detection: {
              analyzed: 2443,
              analyzedWithheld: true,
              found: 940,
              status: "detected",
            },
            harness: "claude",
            label: "Claude Code",
          },
          {
            detection: { analyzed: 4, found: 146, status: "detected" },
            harness: "codex",
            label: "Codex",
          },
        ],
        status: "measured",
      },
      phase: OnboardingPhase.SessionDiscovery,
      progress: {
        missing: OnboardingProgressOperand.AnalyzedSessions,
        status: OnboardingAnalysisProgressStatus.Unavailable,
      },
    });

    const held = screen.getByRole("progressbar", {
      name: "Claude Code import progress",
    });
    const live = screen.getByRole("progressbar", {
      name: "Codex import progress",
    });
    // Two rows in genuinely different states is what makes this able to fail:
    // one fixture source cannot tell a per-source marker from an aggregate one.
    expect(held.querySelector("[data-slot='progress-sheen']")).toBeNull();
    expect(live.querySelector("[data-slot='progress-sheen']")).not.toBeNull();
    // And the live row states its own 3%, rather than an indeterminate bar.
    expect(live.getAttribute("aria-valuenow")).toBe("3");
  });

  it("renders the real percentage the parse lane supports, rather than withholding it", () => {
    // What the byte transport buys: the same irreconcilable store, with the
    // parse lane's own position now reaching the fold. A percentage is a
    // measurement, so it renders as one — determinate, and not 100.
    renderDialog({
      discovery: {
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
        logBytes: 8192,
        sessionsAnalyzed: null,
        sessionsFound: 1092,
        sources: [],
        status: "measured",
      },
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(36),
    });

    const overall = screen.getByRole("progressbar", {
      name: "Overall import progress",
    });
    expect(overall.getAttribute("aria-valuenow")).toBe("36");
    expect(screen.getByText("36%")).not.toBeNull();
    expect(screen.queryByText(KPI_NO_VALUE)).toBeNull();
    expect(screen.queryByText(ANALYZED_UNAVAILABLE_LABEL)).toBeNull();
  });

  it("does not round 3,985 of 4,004 into a completed source", () => {
    renderDialog({
      discovery: {
        ...measuredFixture(),
        sources: [
          {
            detection: { analyzed: 3985, found: 4004, status: "detected" },
            harness: "claude",
            label: "Claude Code",
          },
        ],
      },
      phase: OnboardingPhase.SessionDiscovery,
      progress: measuredAnalysisProgress(99),
    });

    const bar = screen.getByRole("progressbar", {
      name: "Claude Code import progress",
    });
    // 99, not 100: a completion claim is a count identity, not a rounding.
    expect(bar.getAttribute("aria-valuenow")).toBe("99");
    expect(bar.getAttribute("data-state")).not.toBe("complete");
  });
});

/**
 * The register is the deliverable, not a comment: someone wiring a phase reads
 * it instead of grepping components for numbers that look invented. These
 * assertions keep it usable — a nameless owner or an empty description would
 * make it decoration. Completeness against the view model is enforced at
 * compile time by the `Record<UnwiredOnboardingField, …>` type.
 *
 * Neither assertion here can catch the register naming a field that is already
 * wired; that direction is
 * `../../lib/__tests__/guided-onboarding-unwired-register.test.ts` (ISS-11147).
 */
describe("unwired-data register", () => {
  it("attributes every unwired value to a ticket and a surface", () => {
    const entries = Object.entries(UNWIRED_GUIDED_ONBOARDING_DATA);
    expect(entries.length).toBeGreaterThan(0);

    for (const [field, datum] of entries) {
      expect(datum.ownedBy, `${field} owner`).toMatch(TICKET_SLUG);
      expect(datum.surface.length, `${field} surface`).toBeGreaterThan(0);
      expect(datum.presentsAs.length, `${field} description`).toBeGreaterThan(
        0
      );
    }
  });

  it("registers a fixture value for every field it names", () => {
    for (const field of Object.keys(
      UNWIRED_GUIDED_ONBOARDING_DATA
    ) as UnwiredOnboardingField[]) {
      expect(resolveFixtureValue(field), field).toBeDefined();
    }
  });
});

/** Proves each registered field names something the fixtures actually supply. */
function resolveFixtureValue(field: UnwiredOnboardingField): unknown {
  const values: Record<UnwiredOnboardingField, unknown> = {
    "joinableOrganization.name":
      FIXTURE_JOINABLE_ORGANIZATION.status === "available"
        ? FIXTURE_JOINABLE_ORGANIZATION.name
        : undefined,
    organizationName: FIXTURE_ORGANIZATION_NAME,
  };
  return values[field];
}

const IN_PROGRESS_WORDING = /checking/i;
const LOADING_WORDING = /loading/i;

describe("guided onboarding download step, unmeasured organization", () => {
  it("claims no eligibility check is running when none is", () => {
    // Unknown is reached only from a `membership` that is absent or spelled by
    // another build — never from an in-flight read. Wording or a spinner that
    // implies work in progress would assert activity that never started
    // (ISS-8350).
    renderDialog({ phase: OnboardingPhase.DownloadDesktop });

    expect(screen.queryByText(IN_PROGRESS_WORDING)).toBeNull();
    expect(screen.queryByText(LOADING_WORDING)).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();

    // Positive control: the step DID render, and it states the honest thing.
    expect(
      screen.getByText("Skipping this step isn't available yet.")
    ).not.toBeNull();
  });

  it("does not present an unmeasured organization as a measured refusal", () => {
    // Paired control. Required and Unknown both hide Skip, so the line is the
    // only signal that tells a measured "no data" apart from "nobody looked".
    renderDialog({
      desktopSkipEligibility: OnboardingDesktopSkipEligibility.Required,
      phase: OnboardingPhase.DownloadDesktop,
    });

    expect(
      screen.queryByText("Skipping this step isn't available yet.")
    ).toBeNull();
  });
});

function renderDialog(props: Partial<GuidedOnboardingDialogProps>) {
  return render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      onComplete={vi.fn()}
      open
      {...props}
    />
  );
}
