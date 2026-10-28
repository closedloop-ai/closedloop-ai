import { ARTIFACT_STATUS_DETAIL } from "@repo/api/src/types/artifact-status";
import {
  ARTIFACT_STATUS_DETAIL_LABELS,
  ARTIFACT_STATUS_UNKNOWN_TOOLTIP,
  UNKNOWN_ARTIFACT_STATUS_DISPLAY,
} from "@repo/api/src/types/artifact-status-display";
import { ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY } from "@repo/api/src/types/artifact-status-label-honesty-flag";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  createAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
  unknownStateAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

// ISS-10364 retired the SESSION-status Unknown label this used to read from
// `SESSION_STATUS_LABELS`. The champion-flag-on cases below render the
// UNIVERSAL Artifact Status system's own generic Unknown root label instead
// (`ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.Unknown]`, a
// separate vocabulary this file does not own), which is the literal word
// "Unknown".
const UNKNOWN_STATUS_LABEL = "Unknown";

afterEach(() => vi.useRealTimers());

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
  // ISS-10364 (operator ruling, 2026-09-23): an unparsable status is now folded
  // to Active on import, so this fixture no longer reaches the Unknown badge —
  // that is the change landing, not a regression. What survives from the
  // original ISS-4654 regression is the crash guard: `getStatusDisplay` used to
  // throw on an unrecognized, non-falsy value, and the render below still has
  // to complete rather than throw on it.
  it("renders the Active badge instead of crashing on a state this build does not know", () => {
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
    // The unrecognized status fails open to the same lifecycle value a stored
    // `active` row renders — `resolveDisplayedSessionStatus` no longer produces
    // a distinct Unknown word for it (ISS-10364).
    fireEvent.click(screen.getByText("Properties"));
    expect(
      screen.getAllByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]).length
    ).toBeGreaterThan(0);
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
    expect(screen.queryByText(UNKNOWN_STATUS_LABEL)).not.toBeInTheDocument();
  });

  /*
   * ISS-4654 (PR #4630 review) added the disclosure this case pinned: the
   * Unknown word never travelled alone, so a reader could tell "we cannot
   * parse this" from a state the system actually has. ISS-10364 (operator
   * ruling, 2026-09-23) removed the word itself for this fixture — an
   * unparsable status is folded to Active on import — so there is no longer an
   * Unknown badge here to explain. Kept as a counterfactual: a status this
   * build cannot read must render the same plain, unexplained Active label a
   * recognized status gets, not a half-migrated hybrid.
   */
  it("renders an unparsable status as plain Active, with no leftover Unknown disclosure", () => {
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
    expect(row).toHaveTextContent(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]);
  });

  // ISS-10364 (operator ruling): an unparsable status reads Active everywhere,
  // the universal champion included, so with the champion on, honesty gate or
  // not, neither the header nor the Properties row shows Unknown or explains it.
  it.each([
    ["off", [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY]],
    [
      "on",
      [
        UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY,
        ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY,
      ],
    ],
  ] as const)(
    "reads a future raw status as Active under the champion with honesty %s",
    (_honesty, enabledFlags) => {
      const { container } = render(
        <AppCoreStoryProviders enabledFlags={[...enabledFlags]}>
          <AgentSessionDetailView
            backHref="/sessions"
            isLoading={false}
            session={unknownStateAgentSessionDetailFixture}
          />
        </AppCoreStoryProviders>
      );

      fireEvent.click(screen.getByText("Properties"));
      const row = statusRow(container);
      expect(row).toHaveTextContent(
        ARTIFACT_STATUS_DETAIL_LABELS[ARTIFACT_STATUS_DETAIL.SessionRunning]
      );
      expect(row).not.toHaveTextContent(UNKNOWN_STATUS_LABEL);
      expect(screen.queryByTitle(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).toBeNull();
      expect(
        screen.queryByRole("img", {
          name: UNKNOWN_ARTIFACT_STATUS_DISPLAY.accessibleName,
        })
      ).toBeNull();
    }
  );

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
    // status this build knows is a value, so it gains no borrowed explanation.
    // Read through the SAME accessor as the case above, so a row that stopped
    // rendering entirely cannot pass this by absence.
    //
    // ISS-7019: the word is "Inactive", not "Completed". BEHAVIOR CHANGE, not a
    // loosened assertion — the row renders the displayed status now, so it says
    // what the Sessions list says about the same run instead of the deleted
    // `AgentSessionState`'s separate vocabulary.
    fireEvent.click(screen.getByText("Properties"));
    const row = statusRow(container);
    expect(row).toHaveTextContent(
      SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE]
    );
  });

  // ISS-10364: this fixture's `lastActivityAt` sits 48h before `now`, past the
  // 24h staleness threshold that used to fold a silent `active` row to Stale.
  // That fold is gone, so the Properties row and the title header both keep
  // reading Active regardless of elapsed time — the parity this case pins is
  // now "neither surface reintroduces a staleness word on its own", not "both
  // agree on which word to show".
  it("keeps the Properties status aligned with the header once staleness stopped folding it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
    const { container, unmount } = render(
      <AppCoreStoryProviders>
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            endedAt: null,
            lastActivityAt: new Date("2026-09-15T12:00:00.000Z"),
            startedAt: new Date("2026-09-15T11:00:00.000Z"),
            status: SESSION_STATUS.ACTIVE,
          })}
        />
      </AppCoreStoryProviders>
    );

    fireEvent.click(screen.getByText("Properties"));
    expect(statusRow(container)).toHaveTextContent(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );
    unmount();
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
