import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootErrorBoundary } from "../root-error-boundary";

describe("RootErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports render errors and preserves fallback UI", () => {
    const reportException = vi.fn();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <RootErrorBoundary reportException={reportException}>
        <ThrowingChild />
      </RootErrorBoundary>
    );

    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(reportException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining("ThrowingChild")
    );
    // FEA-4111 removed the boundary's own console line — React already prints a
    // caught render error, and a second copy never reached the aggregator. The
    // spy is still installed because React's own logging goes through it; assert
    // only that the boundary contributes no message of its own.
    expect(
      consoleErrorSpy.mock.calls
        .flat()
        .some((argument) =>
          String(argument).includes("Desktop renderer error boundary")
        )
    ).toBe(false);
  });
});

function ThrowingChild(): never {
  throw new Error("render failed");
}
