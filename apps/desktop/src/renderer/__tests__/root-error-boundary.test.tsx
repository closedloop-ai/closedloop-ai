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
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Desktop renderer error boundary caught an error",
      expect.any(Error),
      {
        componentStack: expect.stringContaining("ThrowingChild"),
      }
    );
  });
});

function ThrowingChild(): never {
  throw new Error("render failed");
}
