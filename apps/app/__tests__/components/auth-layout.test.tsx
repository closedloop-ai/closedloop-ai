/**
 * Unit tests for the unauthenticated AuthLayout component.
 * Verifies Closedloop branding, logo rendering, child rendering, the wordmark
 * link target, and the single main landmark.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AuthLayout from "@/app/(unauthenticated)/layout";
import { env } from "@/env";

const CLERK_FAILURE_NOTICE_TEST_ID = "clerk-load-failure-notice";
const CLERK_FAILURE_GATE_TEST_ID = "hide-when-clerk-failed";

vi.mock("@/app/(unauthenticated)/clerk-load-failure-notice", () => ({
  ClerkLoadFailureNotice: () => (
    <div data-testid={CLERK_FAILURE_NOTICE_TEST_ID} />
  ),
  HideWhenClerkFailed: ({ children }: { children: React.ReactNode }) => (
    <div data-testid={CLERK_FAILURE_GATE_TEST_ID}>{children}</div>
  ),
}));

// @repo/navigation/link is stubbed globally in vitest.setup.ts.

describe("AuthLayout — Closedloop branding", () => {
  it("renders the logo images with correct alt text", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    const logos = screen.getAllByRole("img", { name: "Closedloop logo" });
    expect(logos.length).toBe(2);
  });

  it("renders the product screenshot", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    expect(
      screen.getByRole("img", { name: "Closedloop product screenshot" })
    ).toBeInTheDocument();
  });

  it("renders children in the content area", () => {
    render(
      <AuthLayout>
        <div data-testid="page-content">sign in form</div>
      </AuthLayout>
    );

    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });

  it("wraps the page in a single main landmark", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("points the wordmark at the marketing site, not the app root", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    // `/` redirects a signed-out visitor into sign-up; the wordmark must go to
    // the marketing site instead.
    expect(
      screen.getByRole("link", { name: "Closedloop home" })
    ).toHaveAttribute("href", env.NEXT_PUBLIC_WEB_URL);
  });
});

describe("AuthLayout — Clerk load failure (ISS-11429)", () => {
  it("mounts the Clerk load-failure notice so every auth screen is covered", () => {
    // Mounted on the LAYOUT rather than on each page: `/sign-up`, `/sign-in`,
    // `/sso-callback` and `/connect/github` all render inside this group, and the
    // measured failures hit more than one of them. Per-page mounts would leave
    // whichever page was forgotten showing a permanently empty card.
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    expect(
      screen.getByTestId(CLERK_FAILURE_NOTICE_TEST_ID)
    ).toBeInTheDocument();
  });

  it("routes the page's own content through the failure gate", () => {
    // The notice REPLACES the page rather than sitting beside it: `/sso-callback`
    // and `/connect/github` keep a busy `AuthTransitionPanel` up through a Clerk
    // failure, so an ungated child left the screen asserting both states at once.
    render(
      <AuthLayout>
        <div data-testid="page-content">child</div>
      </AuthLayout>
    );

    expect(screen.getByTestId(CLERK_FAILURE_GATE_TEST_ID)).toContainElement(
      screen.getByTestId("page-content")
    );
  });
});
