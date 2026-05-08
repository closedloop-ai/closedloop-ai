/**
 * Unit tests for the unauthenticated AuthLayout component.
 * Verifies ClosedLoop branding, logo rendering, and child rendering.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AuthLayout from "@/app/(unauthenticated)/layout";

describe("AuthLayout — ClosedLoop branding", () => {
  it("renders the logo images with correct alt text", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    const logos = screen.getAllByRole("img", { name: "ClosedLoop logo" });
    expect(logos.length).toBe(2);
  });

  it("renders the product screenshot", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    expect(
      screen.getByRole("img", { name: "ClosedLoop product screenshot" })
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
