import type { ActivitySegment } from "@repo/api/src/types/agent-session";
import { SessionTracePhaseSourceType } from "@repo/api/src/types/agent-session";
import { SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionActivityBreakdown } from "../session-activity-breakdown";
import { activitySegmentFixture as segment } from "./activity-segment-fixtures";

/**
 * ISS-5564 — the Activity breakdown asserted a precise dollar attribution and,
 * one column over, admitted no confidence in the classification the dollars were
 * grouped under.
 *
 * The captured session (SES-80519):
 *
 *   Phase     Source     Conf.   Time    Tokens   Cost    Cost %
 *   Other     inferred     0%      9s    80.4k    $0.81     79%
 *   Explore   inferred    70%     30s   331.9k    $0.21     21%
 *
 * The arithmetic reconciles ($0.81 + $0.21 = $1.02, 79% + 21% = 100%), so this
 * is not a math defect — it is an unexplained pair of numbers that cannot both
 * be taken at face value. The panel already pre-empts exactly this misreading
 * for its other ambiguous column ("Shares are by cost, not time.") and for its
 * residual row; the confidence column had no such sentence.
 */

/** The reported shape, with the confidence and cost split that produced it. */
const ZERO_CONFIDENCE_SEGMENTS: ActivitySegment[] = [
  segment({
    key: "other",
    costUsd: 0.81,
    durationMs: 9000,
    confidence: 0,
    source: SessionTracePhaseSourceType.LoopPerf,
    inputTokens: 80_400,
  }),
  segment({
    key: "explore",
    costUsd: 0.21,
    durationMs: 30_000,
    confidence: 0.7,
    source: SessionTracePhaseSourceType.LoopPerf,
    inputTokens: 331_900,
  }),
];

/** Same money, but every phase is confidently classified. */
const CONFIDENT_SEGMENTS: ActivitySegment[] = [
  segment({
    key: "implement",
    costUsd: 0.81,
    durationMs: 9000,
    confidence: 0.94,
    source: SessionTracePhaseSourceType.LoopPerf,
  }),
  segment({
    key: "explore",
    costUsd: 0.21,
    durationMs: 30_000,
    confidence: 0.7,
    source: SessionTracePhaseSourceType.LoopPerf,
  }),
];

const CONFIDENCE_BASIS_RE =
  /Confidence describes the phase name, not the money/i;

function renderPanel(node: ReactNode, enabledFlags: readonly string[]) {
  return render(node, {
    wrapper: ({ children }) => (
      <AppCoreStoryProviders enabledFlags={enabledFlags}>
        {children}
      </AppCoreStoryProviders>
    ),
  });
}

function renderWithDisclosure(segments: ActivitySegment[]) {
  return renderPanel(
    <SessionActivityBreakdown
      session={createAgentSessionDetailFixture({ activitySegments: segments })}
    />,
    [SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY]
  );
}

describe("SessionActivityBreakdown — ISS-5564 confidence basis", () => {
  it("explains the contradiction when a 0%-confidence phase carries real cost", () => {
    const { container } = renderWithDisclosure(ZERO_CONFIDENCE_SEGMENTS);

    // The pair that provoked the report is still on screen — the fix adds a
    // sentence, it does not suppress the row or hide the confidence.
    expect(container.textContent).toContain("0%");
    expect(container.textContent).toContain("$0.81");
    // ...and the panel now says which of the two numbers the reader should
    // distrust, in the direction that is actually true.
    expect(container.textContent).toMatch(CONFIDENCE_BASIS_RE);
  });

  it("stays silent when every phase is confidently classified", () => {
    // The guard against an unconditional caveat: a session with nothing to
    // explain must not pay for the explanation.
    const { container } = renderWithDisclosure(CONFIDENT_SEGMENTS);

    expect(container.textContent).toContain("$0.81");
    expect(container.textContent).not.toMatch(CONFIDENCE_BASIS_RE);
  });

  it("keys off the DISPLAYED confidence, so a phase rounding to 0% also qualifies", () => {
    // The `Conf.` cell renders `Math.round(confidence * 100)`, so 0.002 shows as
    // `0%`. The sentence must follow what the reader SEES, not the raw float —
    // otherwise a row displaying `0%` sits there unexplained.
    const { container } = renderWithDisclosure([
      segment({
        key: "other",
        costUsd: 0.81,
        durationMs: 9000,
        confidence: 0.002,
        source: SessionTracePhaseSourceType.LoopPerf,
      }),
      segment({ key: "explore", costUsd: 0.21, confidence: 0.7 }),
    ]);

    expect(container.textContent).toContain("0%");
    expect(container.textContent).toMatch(CONFIDENCE_BASIS_RE);
  });

  it("does not fire for a 0%-confidence phase that carries no cost", () => {
    // Nothing is being asserted about that phase's money, so there is no
    // precise-figure-vs-no-confidence contradiction to resolve.
    const { container } = renderWithDisclosure([
      segment({
        key: "other",
        costUsd: 0,
        durationMs: 9000,
        confidence: 0,
        source: SessionTracePhaseSourceType.LoopPerf,
      }),
      segment({ key: "explore", costUsd: 1.02, confidence: 0.7 }),
    ]);

    expect(container.textContent).not.toMatch(CONFIDENCE_BASIS_RE);
  });

  it("does not fire for a sub-cent phase whose Cost cell renders $0.00", () => {
    // Code review: with cost reconciliation off, the trigger sees the raw
    // `costUsd` float. A phase holding $0.001 is `> 0` as a float but its Cost
    // cell renders `$0.00`, so firing here would put a sentence about "its
    // measured cost" beside a row showing no cost at all.
    const { container } = renderWithDisclosure([
      segment({
        key: "other",
        costUsd: 0.001,
        durationMs: 9000,
        confidence: 0,
        source: SessionTracePhaseSourceType.LoopPerf,
      }),
      segment({ key: "explore", costUsd: 1.02, confidence: 0.7 }),
    ]);

    expect(container.textContent).toContain("0%");
    expect(container.textContent).not.toMatch(CONFIDENCE_BASIS_RE);
  });

  it("does not fire for a phase whose confidence is unknown rather than zero", () => {
    // A null confidence renders the shared unknown dash, which claims nothing
    // about certainty — the synthesized residual row is the main such case and
    // it has its own sentence already.
    const { container } = renderWithDisclosure([
      segment({ key: "other", costUsd: 0.81, confidence: null }),
      segment({ key: "explore", costUsd: 0.21, confidence: 0.7 }),
    ]);

    expect(container.textContent).not.toMatch(CONFIDENCE_BASIS_RE);
  });

  it("keeps the disclosure closed by default (ISS-4779)", () => {
    // Flag OFF: the perceivable copy must not ship on until it is turned on.
    // No flag is enabled here — the same shape this panel mounts in under
    // Storybook and unit tests, where the optional read resolves off.
    const { container } = renderPanel(
      <SessionActivityBreakdown
        session={createAgentSessionDetailFixture({
          activitySegments: ZERO_CONFIDENCE_SEGMENTS,
        })}
      />,
      []
    );

    expect(container.textContent).toContain("0%");
    expect(container.textContent).not.toMatch(CONFIDENCE_BASIS_RE);
  });

  it("leaves the panel's existing basis sentence and figures untouched", () => {
    // The change is additive copy: no number moves, and the sentence it sits
    // beside is unchanged.
    const { container } = renderWithDisclosure(ZERO_CONFIDENCE_SEGMENTS);

    expect(container.textContent).toContain("Shares are by cost, not time.");
    expect(container.textContent).toContain("$0.81");
    expect(container.textContent).toContain("$0.21");
  });
});
