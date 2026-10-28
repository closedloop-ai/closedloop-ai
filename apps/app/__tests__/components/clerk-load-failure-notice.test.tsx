import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClerkLoadFailureNotice,
  HideWhenClerkFailed,
} from "@/app/(unauthenticated)/clerk-load-failure-notice";
import { RumErrorSource } from "@/lib/datadog-rum/error-source";

/**
 * ISS-11429. `failed_to_load_clerk_ui` on `/sign-up` and
 * `failed_to_load_clerk_js` elsewhere were measured on the prod host, and in
 * every one of them Clerk's embed renders NO markup — so the visitor sat in
 * front of a permanently empty auth card with no statement that anything had
 * gone wrong and no way to retry. These cases pin both halves of the fix: the
 * user is told, and the condition is reported to the existing monitored channel
 * (the repo bans a client-side console log for this).
 */

const FAILURE_HEADING = /couldn't finish loading/i;
const CLERK_LOAD_CODE = /failed_to_load/;
const SIGN_IN_FORM_COPY = /sign-in form/i;

const clerkStatus = vi.hoisted(() => ({ value: "error" }));

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ status: clerkStatus.value }),
}));

const reportNextjsErrorMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/datadog-rum/report-error", () => ({
  reportNextjsError: reportNextjsErrorMock,
}));

beforeEach(() => {
  clerkStatus.value = "error";
  reportNextjsErrorMock.mockClear();
});

describe("ClerkLoadFailureNotice", () => {
  it("renders nothing while Clerk has not failed", () => {
    clerkStatus.value = "ready";
    const { container } = render(<ClerkLoadFailureNotice />);

    expect(container.firstChild).toBeNull();
    // The flip side of the fix: a slow-but-working load must not be reported as
    // a failure, so the report is gated on the same condition as the render.
    expect(reportNextjsErrorMock).not.toHaveBeenCalled();
  });

  it("renders nothing while Clerk is still loading", () => {
    clerkStatus.value = "loading";
    const { container } = render(<ClerkLoadFailureNotice />);

    expect(container.firstChild).toBeNull();
  });

  it("states the failure and offers a way out when Clerk has failed", () => {
    render(<ClerkLoadFailureNotice />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(FAILURE_HEADING)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("reports the condition under its own monitored source", () => {
    render(<ClerkLoadFailureNotice />);

    expect(reportNextjsErrorMock).toHaveBeenCalledTimes(1);
    const [error, context] = reportNextjsErrorMock.mock.calls[0];
    expect(context).toEqual({ source: RumErrorSource.ClerkLoad });
    // Deliberately silent about WHICH Clerk code failed: the gate reads only
    // `status === "error"`, so naming `failed_to_load_clerk_js` here would be a
    // cause this component never observed.
    expect((error as Error).message).not.toMatch(CLERK_LOAD_CODE);
  });

  it("reports once per mount, not once per render", () => {
    const { rerender } = render(<ClerkLoadFailureNotice />);
    rerender(<ClerkLoadFailureNotice />);
    rerender(<ClerkLoadFailureNotice />);

    // One broken load must not read as many incidents in the monitor.
    expect(reportNextjsErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("HideWhenClerkFailed", () => {
  it("renders the page's own content while Clerk has not failed", () => {
    clerkStatus.value = "ready";
    render(
      <HideWhenClerkFailed>
        <div data-testid="page-content">panel</div>
      </HideWhenClerkFailed>
    );

    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });

  it("withholds the page's own content once Clerk has failed", () => {
    // The contradiction this closes: `/sso-callback` and `/connect/github` drive
    // an `AuthTransitionPanel` from a phase Clerk's failure never advances, so
    // the busy panel stayed up beside the failure notice — one saying the
    // sign-in was still running, the other saying it had failed.
    render(
      <HideWhenClerkFailed>
        <div data-testid="page-content">panel</div>
      </HideWhenClerkFailed>
    );

    expect(screen.queryByTestId("page-content")).not.toBeInTheDocument();
  });
});

describe("ClerkLoadFailureNotice — it is the only thing left on the screen", () => {
  it("owns the page's heading, because the page's own panel is gone", () => {
    render(<ClerkLoadFailureNotice />);

    // `AuthTransitionPanel` carried the only `h1` on `/sso-callback` and
    // `/connect/github`, and `HideWhenClerkFailed` takes it down in this state —
    // so without this the failed screen would have no heading at all.
    expect(
      screen.getByRole("heading", { level: 1, name: FAILURE_HEADING })
    ).toBeInTheDocument();
  });

  it("names the page rather than a form only two of the four screens have", () => {
    render(<ClerkLoadFailureNotice />);

    // "We couldn't load the sign-in form" was wrong on `/sso-callback`, which is
    // a handshake screen with no form on it at all.
    expect(screen.queryByText(SIGN_IN_FORM_COPY)).not.toBeInTheDocument();
  });
});
