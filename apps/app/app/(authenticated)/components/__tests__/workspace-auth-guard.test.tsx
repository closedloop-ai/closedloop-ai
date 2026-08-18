/**
 * WorkspaceAuthGuard behavior (FEA-3940, narrowed by ISS-5095): a persistent auth
 * failure — a 401/403 on the `/me` identity probe it observes, OR a **401** from
 * any other query surfaced through the shared auth-rejection store — must render
 * a recovery surface (Sign in + Retry) in the main region instead of the blank
 * children, while any non-auth state renders the children unchanged.
 *
 * The asymmetry between the two signals is the ISS-5095 contract and is pinned
 * below: `/me` trips on 403 (a forbidden answer to "who am I" means the session
 * cannot be established) but a BARE 403 from some other query does NOT (it means
 * one resource is not yours, and blanking the workspace over it told the user
 * their healthy session had expired). A 403 the server tagged session-level does
 * trip it — and says so in its own words rather than borrowing the
 * session-expired copy, because that session is not expired.
 *
 * Sign in clears the poisoned Clerk session and routes to `/sign-in`; Retry
 * invalidates the current-user query. Copy is a single "session expired" voice
 * shared with the desktop banner, and a failed sign-out surfaces feedback
 * instead of a dead button.
 */

import {
  AuthErrorCode,
  ORG_UNVERIFIABLE_MESSAGE,
} from "@repo/api/src/types/auth-error";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  clearAuthRejection,
  publishAuthRejectionIfAuthError,
} from "@repo/app/shared/query/auth-rejection-store";
import { userKeys } from "@repo/app/users/hooks/use-users";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAuthGuard } from "../workspace-auth-guard";

const mockUseCurrentUser = vi.fn();
const mockSignOut = vi.fn(() => Promise.resolve());
const mockInvalidateQueries = vi.fn();

vi.mock("@repo/app/users/hooks/use-users", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/users/hooks/use-users")
  >("@repo/app/users/hooks/use-users");
  return {
    ...actual,
    useCurrentUser: (options?: unknown) => mockUseCurrentUser(options),
  };
});

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ signOut: mockSignOut }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

const CHILD_TEXT = "workspace content";
const SIGN_IN_BUTTON_RE = /sign in/i;
const RETRY_BUTTON_RE = /retry/i;
const SESSION_EXPIRED_RE = /session expired/i;
const ORG_UNCONFIRMED_RE = /couldn't confirm your organization/i;
const ORG_UNCHECKED_RE = /couldn't check your organization/i;
const SIGN_OUT_FAILED_RE = /couldn't start the sign-in flow/i;

function renderGuard() {
  return render(
    <WorkspaceAuthGuard>
      <div>{CHILD_TEXT}</div>
    </WorkspaceAuthGuard>
  );
}

describe("WorkspaceAuthGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignOut.mockReturnValue(Promise.resolve());
  });

  afterEach(() => {
    cleanup();
    // The guard subscribes to the real (module-level) auth-rejection store; drop
    // any latched signal so it does not leak into the next test.
    clearAuthRejection();
  });

  it("renders children when there is no error", () => {
    mockUseCurrentUser.mockReturnValue({ error: null, isError: false });
    renderGuard();
    expect(screen.getByText(CHILD_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the recovery surface (not blank children) on a 401", () => {
    mockUseCurrentUser.mockReturnValue({
      error: new ApiError("Unauthorized", 401),
      isError: true,
    });
    renderGuard();

    expect(screen.queryByText(CHILD_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(SESSION_EXPIRED_RE)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SIGN_IN_BUTTON_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RETRY_BUTTON_RE })
    ).toBeInTheDocument();
  });

  it("renders the same recovery surface on a /me 403 (one voice, not three)", () => {
    mockUseCurrentUser.mockReturnValue({
      error: new ApiError("Forbidden", 403),
      isError: true,
    });
    renderGuard();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(CHILD_TEXT)).not.toBeInTheDocument();
    // 401 and 403 share one message *on `/me`*: it is the identity probe, so a
    // forbidden answer there means the session cannot be established and re-auth
    // is the fix either way. This is deliberately NOT true of other queries —
    // see the cross-query 403 case below.
    expect(screen.getByText(SESSION_EXPIRED_RE)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SIGN_IN_BUTTON_RE })
    ).toBeInTheDocument();
  });

  it("trips on a cross-query auth rejection even when /me is not in error", () => {
    // /me last succeeded (fresh, not refetching), then another query 401s.
    mockUseCurrentUser.mockReturnValue({ error: null, isError: false });
    renderGuard();
    expect(screen.getByText(CHILD_TEXT)).toBeInTheDocument();

    act(() => {
      publishAuthRejectionIfAuthError(new ApiError("Unauthorized", 401));
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(SESSION_EXPIRED_RE)).toBeInTheDocument();
    expect(screen.queryByText(CHILD_TEXT)).not.toBeInTheDocument();
  });

  // ISS-5095, the shell-blanking regression itself: an org member opened Create
  // PRD, one sub-resource read (GET /teams/:id/repositories) 403'd, and the whole
  // main region was replaced by "Your session expired" — whose Sign in button
  // then signed out a perfectly healthy session. A resource 403 must leave the
  // workspace rendering so the owning surface can show its own error.
  it("keeps rendering the workspace on a cross-query 403 (a forbidden resource is not a dead session)", () => {
    mockUseCurrentUser.mockReturnValue({ error: null, isError: false });
    renderGuard();
    expect(screen.getByText(CHILD_TEXT)).toBeInTheDocument();

    act(() => {
      publishAuthRejectionIfAuthError(new ApiError("Forbidden", 403));
    });

    expect(screen.getByText(CHILD_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(SESSION_EXPIRED_RE)).not.toBeInTheDocument();
  });

  // ISS-5095 review: the session-tagged 403 still raises the card, but it must
  // not claim an expired session. The user's session is intact; the org could
  // not be confirmed. Signing in again is not the likely fix, so the copy — and
  // the button order that follows it — differ from the 401 case above.
  it("names the org failure instead of claiming an expired session on a tagged 403", () => {
    mockUseCurrentUser.mockReturnValue({ error: null, isError: false });
    renderGuard();

    act(() => {
      publishAuthRejectionIfAuthError(
        new ApiError("Forbidden", 403, { code: AuthErrorCode.OrgForbidden })
      );
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(CHILD_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(ORG_UNCONFIRMED_RE)).toBeInTheDocument();
    expect(screen.queryByText(SESSION_EXPIRED_RE)).not.toBeInTheDocument();
    // Both recoveries stay available; Retry leads because it is the one that
    // clears an org-switch race. (A transient Clerk lookup FAILURE is no longer
    // this case — ISS-5118 routes that to `OrgUnverifiable`, covered below.)
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveTextContent(RETRY_BUTTON_RE);
    expect(
      screen.getByRole("button", { name: SIGN_IN_BUTTON_RE })
    ).toBeInTheDocument();
  });

  // ISS-5118 (review): the outage state is the one card that must NOT offer Sign
  // in. Signing in again cannot reach a provider that is down, and it destroys a
  // working session to find that out. Asserting the button is ABSENT is the
  // point — a test that only checked the title would pass with the harmful
  // action still on screen.
  it("offers only Retry, and never claims a dead session, on an unverifiable org", () => {
    mockUseCurrentUser.mockReturnValue({ error: null, isError: false });
    renderGuard();

    act(() => {
      publishAuthRejectionIfAuthError(
        new ApiError(ORG_UNVERIFIABLE_MESSAGE, 503, {
          code: AuthErrorCode.OrgUnverifiable,
        })
      );
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    // The shell is replaced at all: the org header rides every request, so this
    // outage fails every query on the page and nothing else is left to explain
    // it. Falling through here is the blank workspace FEA-3940 exists to kill.
    expect(screen.queryByText(CHILD_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(ORG_UNCHECKED_RE)).toBeInTheDocument();
    expect(screen.queryByText(SESSION_EXPIRED_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(ORG_UNCONFIRMED_RE)).not.toBeInTheDocument();

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(RETRY_BUTTON_RE);
    expect(
      screen.queryByRole("button", { name: SIGN_IN_BUTTON_RE })
    ).not.toBeInTheDocument();
  });

  it("leads with Sign in for a genuinely expired session", () => {
    mockUseCurrentUser.mockReturnValue({
      error: new ApiError("Unauthorized", 401),
      isError: true,
    });
    renderGuard();
    expect(screen.getAllByRole("button")[0]).toHaveTextContent(
      SIGN_IN_BUTTON_RE
    );
  });

  it("falls through to children on a non-auth API error", () => {
    mockUseCurrentUser.mockReturnValue({
      error: new ApiError("Server error", 500),
      isError: true,
    });
    renderGuard();
    expect(screen.getByText(CHILD_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls through to children on a bare network error", () => {
    mockUseCurrentUser.mockReturnValue({
      error: new TypeError("Failed to fetch"),
      isError: true,
    });
    renderGuard();
    expect(screen.getByText(CHILD_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Sign in clears the session and routes to the sign-in page", () => {
    mockUseCurrentUser.mockReturnValue({
      error: new ApiError("Unauthorized", 401),
      isError: true,
    });
    renderGuard();

    fireEvent.click(screen.getByRole("button", { name: SIGN_IN_BUTTON_RE }));
    expect(mockSignOut).toHaveBeenCalledWith({ redirectUrl: "/sign-in" });
  });

  it("surfaces feedback when Sign in fails instead of a dead button", async () => {
    mockUseCurrentUser.mockReturnValue({
      error: new ApiError("Unauthorized", 401),
      isError: true,
    });
    mockSignOut.mockReturnValue(Promise.reject(new Error("clerk down")));
    renderGuard();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SIGN_IN_BUTTON_RE }));
      // Let the rejected signOut promise settle so its .catch state update runs.
      await Promise.resolve();
    });

    expect(screen.getByText(SIGN_OUT_FAILED_RE)).toBeInTheDocument();
    // Retry is still available as a fallback.
    expect(
      screen.getByRole("button", { name: RETRY_BUTTON_RE })
    ).toBeInTheDocument();
  });

  it("Retry invalidates the current-user query", () => {
    mockUseCurrentUser.mockReturnValue({
      error: new ApiError("Unauthorized", 401),
      isError: true,
    });
    renderGuard();

    fireEvent.click(screen.getByRole("button", { name: RETRY_BUTTON_RE }));
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: userKeys.currentUser(),
    });
  });
});
