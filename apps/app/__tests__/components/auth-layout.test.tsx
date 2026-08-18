/**
 * Unit tests for the unauthenticated AuthLayout component.
 * Verifies Closedloop branding, logo rendering, child rendering, the wordmark
 * link target, and the single main landmark.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AuthLayout from "@/app/(unauthenticated)/layout";

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

    // `/` resolves to the authenticated shell, which redirects a signed-out
    // visitor into sign-up; the wordmark must go to the marketing site instead.
    expect(
      screen.getByRole("link", { name: "Closedloop home" })
    ).toHaveAttribute("href", "http://localhost:3001");
  });
});
