/**
 * Unit tests for the unauthenticated AuthLayout component.
 * Verifies ClosedLoop branding, logo rendering, and child rendering.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/components/ui/mode-toggle", () => ({
  ModeToggle: () => <button type="button">Toggle mode</button>,
}));

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

  it("renders the mode toggle", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    expect(
      screen.getByRole("button", { name: "Toggle mode" })
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
