import { beforeEach, describe, expect, it, vi } from "vitest";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next/navigation", () => ({
  notFound,
}));

vi.mock("../rum-validation-trigger", () => ({
  RumValidationTrigger: () => (
    <button type="button">Trigger validation error</button>
  ),
}));

describe("RumValidationPage", () => {
  beforeEach(() => {
    vi.resetModules();
    notFound.mockClear();
  });

  it("hides the validation route when the server flag is absent", async () => {
    vi.doMock("@/env", () => ({
      env: { RUM_VALIDATION_ROUTE_ENABLED: undefined },
    }));

    const { default: RumValidationPage } = await import("../page");

    expect(() => RumValidationPage()).toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("allows the validation route when the server flag is enabled", async () => {
    vi.doMock("@/env", () => ({
      env: { RUM_VALIDATION_ROUTE_ENABLED: "true" },
    }));

    const { default: RumValidationPage } = await import("../page");

    expect(() => RumValidationPage()).not.toThrow();
    expect(notFound).not.toHaveBeenCalled();
  });
});
