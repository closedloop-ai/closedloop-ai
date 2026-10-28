import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionsEmptyState } from "../../../agents/components/sessions/sessions-empty-state";
import { renderSessionsListLoading } from "../../../agents/components/sessions/sessions-list-loading-body";
import {
  BranchesEmptyState,
  BranchesEmptyVariant,
} from "../../../branches/components/branches-empty-state";
import { ListReadErrorAlert } from "../list-read-error-alert";

/**
 * ISS-7521. The Sessions and Branches errored-read treatments were near-verbatim
 * copies of one `Alert` under a comment asserting their parity held — which had
 * already stopped being true.
 *
 * WHAT THE CHROME CASE BELOW ACTUALLY PINS, precisely: that both surfaces
 * RENDER THE SHARED COMPONENT. Because that component hardcodes the variant,
 * icon and description classes with no prop controlling them, the two chrome
 * values are equal by construction and the comparison is green for whatever
 * those classes happen to be — it is NOT a pin on the class values themselves.
 * It regains teeth for exactly one mutation, which is also the ISS-7521
 * regression: re-hand-rolling one of the two. Do not read it as coverage that
 * the chrome is correct, only that it is shared. ISS-11204 retired what used to
 * be the third surface — the Sessions hard-stall card — rather than re-homing
 * its assertion onto something else; the second case below pins that it is gone.
 */
describe("ListReadErrorAlert (ISS-7521)", () => {
  it("renders error-variant alert chrome with a title, a description and the host's action", () => {
    render(
      <ListReadErrorAlert
        action={<button type="button">Retry</button>}
        description="Something went wrong loading your things."
        title="Couldn't load things"
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-slot", "alert");
    expect(screen.getByText("Couldn't load things")).toBeInTheDocument();
    expect(
      screen.getByText("Something went wrong loading your things.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders without an action rather than inventing one", () => {
    render(
      <ListReadErrorAlert
        description="Something went wrong loading your things."
        title="Couldn't load things"
      />
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders a title and recovery action when the host has no detail copy", () => {
    render(
      <ListReadErrorAlert
        action={<button type="button">Retry</button>}
        title="Couldn't load the summary metrics."
      />
    );

    expect(screen.getByRole("alert")).toHaveAttribute("data-slot", "alert");
    expect(
      screen.getByText("Couldn't load the summary metrics.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("Sessions and Branches errored empties share one alert (ISS-7521)", () => {
  function erroredAlertChrome(container: HTMLElement): {
    alertClass: string | null;
    descriptionClass: string | null;
    iconCount: number;
  } {
    const alert = container.querySelector('[role="alert"]');
    const description = container.querySelector(
      '[data-slot="alert-description"]'
    );
    return {
      alertClass: alert?.getAttribute("class") ?? null,
      descriptionClass: description?.getAttribute("class") ?? null,
      iconCount: alert?.querySelectorAll("svg").length ?? 0,
    };
  }

  /*
   * The CHROME is what these two share and what drifted: alert variant classes,
   * the description's layout classes, and the single leading icon. Copy and the
   * ACTION are deliberately each surface's own — Sessions prefers a host recovery
   * Link and sizes its Retry `sm`, Branches uses the default size. That
   * difference is real, preserved, and an operator call; this case does NOT pin
   * it, and must not be read as evidence the two actions agree.
   */
  it("renders identical alert chrome on both errored empties", () => {
    const sessions = render(
      <SessionsEmptyState
        onRetry={() => undefined}
        signals={{ isUnavailable: true, hasActiveFilters: false }}
      />
    );
    const sessionsChrome = erroredAlertChrome(sessions.container);
    sessions.unmount();

    const branches = render(
      <BranchesEmptyState
        onRetry={() => undefined}
        variant={BranchesEmptyVariant.Unavailable}
      />
    );
    const branchesChrome = erroredAlertChrome(branches.container);
    branches.unmount();

    expect(sessionsChrome.alertClass).not.toBeNull();
    expect(sessionsChrome.descriptionClass).not.toBeNull();
    expect(sessionsChrome.iconCount).toBe(1);
    expect(branchesChrome).toEqual(sessionsChrome);
  });

  it("keeps a stalled load out of the error alert entirely (ISS-11204)", () => {
    // Elapsed time is not a request failure, so a blocking read that has merely
    // taken a while stays on the loading treatment and never claims to have
    // failed. This is the case that stops the retired card coming back.
    const { container } = render(
      <div>
        {renderSessionsListLoading({
          hasData: false,
          isLoading: true,
          loadingLabel: undefined,
          stallPhase: "hard",
        })}
      </div>
    );

    // Presence first, so the absences below cannot be satisfied by a body that
    // rendered nothing at all.
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Loading sessions...")).toBeInTheDocument();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      screen.queryByText("Sessions are temporarily unavailable")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load sessions")
    ).not.toBeInTheDocument();
  });

  it("keeps each surface naming its own noun, never the other's", () => {
    const sessions = render(
      <SessionsEmptyState
        signals={{ isUnavailable: true, hasActiveFilters: false }}
      />
    );
    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    expect(
      screen.getByText("Something went wrong loading your sessions.")
    ).toBeInTheDocument();
    sessions.unmount();

    render(<BranchesEmptyState variant={BranchesEmptyVariant.Unavailable} />);
    expect(screen.getByText("Couldn't load branches")).toBeInTheDocument();
    expect(
      screen.getByText("Something went wrong loading your branches.")
    ).toBeInTheDocument();
  });
});
