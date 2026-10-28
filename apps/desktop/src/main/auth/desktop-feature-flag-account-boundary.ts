import type { DesktopAuthState } from "../../shared/contracts.js";
import { DesktopAuthStatus } from "../../shared/contracts.js";
import type { DesktopMainFeatureFlagAssignmentStore } from "./desktop-feature-flag-assignment.js";
import type { DesktopMainDevMode } from "./desktop-feature-flag-dev-mode.js";

/**
 * Main's flag reads follow the signed-in account: given each auth state, this
 * re-resolves the assignment and Dev Mode on every account BOUNDARY, including
 * sign-out. The store clears synchronously, so the window before the new
 * assignment lands reads CLOSED rather than reading the previous account's
 * verdicts.
 */
export function createFeatureFlagAccountBoundary(deps: {
  assignment: Pick<DesktopMainFeatureFlagAssignmentStore, "resolveFor">;
  devMode: Pick<DesktopMainDevMode, "resolveFor">;
}): (
  state: Pick<DesktopAuthState, "status" | "userId" | "organizationId">
) => void {
  let lastBoundary: string | null = null;
  return (state) => {
    const subject =
      state.status === DesktopAuthStatus.Authenticated ? state.userId : null;
    // ISS-12552: an organization switch is a boundary too, since group
    // flags are answered for the organization.
    const boundary =
      subject === null ? null : `${subject}\u0000${state.organizationId ?? ""}`;
    if (boundary !== lastBoundary) {
      lastBoundary = boundary;
      deps.assignment.resolveFor(subject).catch(() => undefined);
      deps.devMode.resolveFor(subject).catch(() => undefined);
    }
  };
}
