import { SESSION_UNKNOWN_TOOLTIP } from "@repo/api/src/types/session-status-display";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  populatedAgentSessionDetailFixture,
  unknownStateAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/*
 * ISS-4654: version-skew tolerance for the detail status badge.
 *
 * `state` is an UNVERSIONED wire value. An installed Desktop build in Cloud
 * mode indexes its OWN display map by whatever the cloud sends, so a server
 * emitting a member added after that build shipped finds no entry. This is the
 * exact hazard that deferred `AgentSessionState.Inactive` out of #4112.
 *
 * The regression this pins: `getStatusDisplay` used to fall back only when
 * `state` was FALSY, so an unrecognized NON-EMPTY value indexed to `undefined`
 * and the caller dereferenced `.label`/`.icon` on it. The render below throws
 * without the fix rather than merely mislabelling — which is why it asserts the
 * page still renders at all, not just the badge text.
 *
 * ISS-5999 note: the hedge is asserted on the EXPANDED `Status` row rather than
 * on the collapsed strip. ISS-5818 removed status from that strip — the title
 * already carries a chip off the SESSION_STATUS lifecycle axis, and restating
 * `AgentSessionState` 24px below it could put two legitimately-different words in
 * one viewport — and ISS-5999 retired the gate that made the removal
 * conditional. The expanded row is now the only carrier of the ISS-4654
 * explanation, which is exactly why it needs this coverage.
 *
 * The skewed session is the SHARED `unknownStateAgentSessionDetailFixture`, not
 * a local literal: the copy-parity test and the `UnrecognizedState` story need
 * the same one, and the state string has to be a single value or the three stop
 * describing the same scenario. Its cast is deliberate and is the point — the
 * type forbids this value, the WIRE does not. Per the repo's own carve-out, a
 * type boundary stops at a cross-version wire payload, where unknown input is
 * reachable at runtime and must be covered.
 */

describe("AgentSessionDetailView unknown session state (ISS-4654)", () => {
  it("renders the Unknown badge instead of crashing on a state this build does not know", () => {
    render(
      <AppCoreStoryProviders>
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={unknownStateAgentSessionDetailFixture}
        />
      </AppCoreStoryProviders>
    );

    // The page survived: the trace body rendered rather than the whole detail
    // view throwing on the undefined display entry.
    expect(screen.getByText("Session Trace")).toBeInTheDocument();
    // And the badge degrades to the honest "we cannot say" label rather than
    // inventing an outcome for a value this build cannot interpret.
    fireEvent.click(screen.getByText("Properties"));
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  });

  it("still renders a known state with its own label", () => {
    render(
      <AppCoreStoryProviders>
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      </AppCoreStoryProviders>
    );

    // Guards the fallback from swallowing every state: the fixture is
    // Completed, so the badge must NOT read Unknown.
    expect(screen.getByText("Session Trace")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Properties"));
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  /*
   * ISS-4654 (PR #4630 review), retargeted by ISS-5999 from the collapsed strip
   * to the expanded `Status` row. The word alone is not the contract — an
   * unexplained "Unknown" reads like a state the system has, rather than one it
   * cannot interpret — so the REASON has to travel with it, the same disclosure
   * the Sessions list's Unknown pill has carried since ISS-4997.
   */
  it("carries the reason beside the unknown status word on the expanded row", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={unknownStateAgentSessionDetailFixture}
        />
      </AppCoreStoryProviders>
    );

    fireEvent.click(screen.getByText("Properties"));
    const row = statusRow(container);
    expect(row).toHaveTextContent("Unknown");
    // The sentence rides an `sr-only` span inside the row's own trigger, so a
    // screen reader gets the reason without hovering for the tooltip.
    expect(row).toHaveTextContent(SESSION_UNKNOWN_TOOLTIP);
  });

  it("leaves a recognized status unexplained on the expanded row", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      </AppCoreStoryProviders>
    );

    // The disclosure is the hedge's tell, not a blanket restyle of the row: a
    // state this build knows is a value, so it gains no borrowed explanation.
    // Read through the SAME accessor as the case above, so a row that stopped
    // rendering entirely cannot pass this by absence.
    fireEvent.click(screen.getByText("Properties"));
    const row = statusRow(container);
    expect(row).toHaveTextContent("Completed");
    expect(row).not.toHaveTextContent(SESSION_UNKNOWN_TOOLTIP);
  });
});

/** The expanded Properties grid's `Status` row, located by its own label. */
function statusRow(container: HTMLElement): HTMLElement {
  const label = Array.from(
    container.querySelectorAll(".prd-prop .prd-prop-label")
  ).find((node) => node.textContent?.trim() === "Status");
  const row = label?.closest(".prd-prop");
  if (!row) {
    throw new Error("expanded Properties grid rendered no Status row");
  }
  return row as HTMLElement;
}
