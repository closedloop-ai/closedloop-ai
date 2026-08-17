import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-5841, superseding FEA-3906: activity phases come off the Session detail
 * page behind a flag, default OFF.
 *
 * The sibling suites all opt the flag ON because they exist to cover the phases
 * surfaces. This one asserts the DEFAULT — that with no flag the regions are
 * absent — which is the state every user is in until the flag is deliberately
 * turned on, and the one nothing else covers.
 */
const SESSION_NAME = "Phases gate session";

const PHASES_SESSION = createAgentSessionDetailFixture({
  name: SESSION_NAME,
  activitySegments: [
    {
      key: "plan",
      label: "Plan",
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1,
      durationMs: 600_000,
      confidence: 0.9,
      source: "explicit",
    },
  ],
});

const ACTIVITY_BREAKDOWN_HEADING = "Activity breakdown";

function renderDetail(enabledFlags?: readonly string[]) {
  return render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={PHASES_SESSION}
      />,
      enabledFlags
    )
  );
}

describe("Session detail activity phases gate (ISS-5841)", () => {
  it("hides the per-phase breakdown by default", () => {
    renderDetail();
    expect(
      screen.queryByRole("heading", { name: ACTIVITY_BREAKDOWN_HEADING })
    ).toBeNull();
  });

  // Paired with the negative above so the assertion cannot pass because the
  // fixture never had phases in the first place -- the same session with the
  // flag on must show the panel.
  it("shows the per-phase breakdown once the flag is on", () => {
    renderDetail([SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY]);
    expect(
      screen.getByRole("heading", { name: ACTIVITY_BREAKDOWN_HEADING })
    ).toBeTruthy();
  });

  // The rest of the page is not collateral: gating phases must not take the
  // session's identity or its trace with it.
  it("leaves the rest of the detail page intact while phases are off", () => {
    renderDetail();
    expect(screen.getByText(SESSION_NAME)).toBeTruthy();
  });

  /*
   * Moved here from `agent-session-detail-view.test.tsx` (ISS-5841): that file is
   * grandfathered shrink-only, and this is a phases test, so it belongs beside
   * the gate rather than in the general detail suite. Opts the flag ON, since it
   * exists to cover the panel's contents.
   */
  it("FEA-2275: slots the per-phase activity breakdown panel into the detail workspace", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: [
        {
          key: "plan",
          label: "Plan",
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 1,
          durationMs: 600_000,
          confidence: 0.9,
          source: "explicit",
        },
        {
          key: "implement",
          label: "Implement",
          inputTokens: 4000,
          outputTokens: 400,
          cacheReadTokens: 200,
          cacheWriteTokens: 50,
          costUsd: 3.82,
          durationMs: 600_000,
          confidence: 0.6,
          source: "loop_perf",
        },
      ],
    });

    // ISS-5841: the breakdown is flagged off by default; this case covers it.
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={session}
        />,
        [SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY]
      )
    );

    // The breakdown panel is slotted into the detail workspace, one row per
    // derived phase. (The raw-tiling strip above it is FEA-3705's
    // SessionActivitySegments, covered by that component's own tests.)
    expect(
      screen.getByRole("heading", { name: "Activity breakdown" })
    ).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Implement")).toBeInTheDocument();
  });
});
