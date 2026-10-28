import { beforeEach, describe, expect, it, vi } from "vitest";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next/navigation", () => ({
  notFound,
}));

vi.mock("../error-boundary-validation-trigger", () => ({
  ErrorBoundaryValidationTrigger: () => (
    <button type="button">Trigger boundary error</button>
  ),
}));

describe("ErrorBoundaryValidationPage", () => {
  beforeEach(() => {
    vi.resetModules();
    notFound.mockClear();
  });

  it("hides the throwing route when the server flag is absent", async () => {
    vi.doMock("@/env", () => ({
      env: { ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED: undefined },
    }));

    const { default: ErrorBoundaryValidationPage } = await import("../page");

    expect(() => ErrorBoundaryValidationPage()).toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("hides the throwing route when the flag is explicitly false", async () => {
    vi.doMock("@/env", () => ({
      env: { ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED: "false" },
    }));

    const { default: ErrorBoundaryValidationPage } = await import("../page");

    expect(() => ErrorBoundaryValidationPage()).toThrow("NEXT_NOT_FOUND");
  });

  it("serves the throwing route only when the flag is enabled", async () => {
    vi.doMock("@/env", () => ({
      env: { ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED: "true" },
    }));

    const { default: ErrorBoundaryValidationPage } = await import("../page");

    expect(() => ErrorBoundaryValidationPage()).not.toThrow();
    expect(notFound).not.toHaveBeenCalled();
  });
});
