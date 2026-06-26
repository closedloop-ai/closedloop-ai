/**
 * Unit tests for the unauthenticated AuthLayout component.
 * Verifies Closedloop branding, logo rendering, and child rendering.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AuthLayout from "@/app/(unauthenticated)/layout";

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
});
