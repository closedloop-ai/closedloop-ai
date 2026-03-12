/**
 * Unit tests for the unauthenticated AuthLayout component.
 * Verifies ClosedLoop branding, tagline, testimonial, and child rendering.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/components/ui/mode-toggle", () => ({
  ModeToggle: () => <button type="button">Toggle mode</button>,
}));

import AuthLayout from "@/app/(unauthenticated)/layout";

describe("AuthLayout — ClosedLoop branding", () => {
  it("renders the ClosedLoop brand name", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    expect(screen.getByText("ClosedLoop")).toBeInTheDocument();
  });

  it("renders the logo image with correct alt text", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    expect(
      screen.getByRole("img", { name: "ClosedLoop logo" })
    ).toBeInTheDocument();
  });

  it("renders the tagline", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    // The tagline appears twice: once below the logo and once in the footer panel
    const taglines = screen.getAllByText("Go fast AND go together.");
    expect(taglines.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the ClosedLoop.ai testimonial heading", () => {
    render(
      <AuthLayout>
        <div>child</div>
      </AuthLayout>
    );

    expect(screen.getByText("ClosedLoop.ai")).toBeInTheDocument();
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
