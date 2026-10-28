import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootErrorBoundary } from "../root-error-boundary";

describe("RootErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLocationDescriptor) {
      Object.defineProperty(globalThis, "location", originalLocationDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "location");
    }
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

  it("reloads the desktop window from the fallback UI", () => {
    const reload = vi.fn();
    silenceReactError();
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { reload },
    });

    render(
      <RootErrorBoundary reportException={vi.fn()}>
        <ThrowingChild />
      </RootErrorBoundary>
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("preserves the fallback when reportException is omitted", () => {
    silenceReactError();

    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>
    );

    expect(screen.getByText("Something went wrong")).toBeTruthy();
  });

  it("reports a null component stack as undefined", () => {
    const error = new Error("render failed");
    const reportException = vi.fn();
    const boundary = new RootErrorBoundary({
      children: null,
      reportException,
    });

    boundary.componentDidCatch(error, { componentStack: null });

    expect(reportException).toHaveBeenCalledWith(error, undefined);
  });

  it("renders children when nothing throws", () => {
    render(
      <RootErrorBoundary>
        <div>Desktop ready</div>
      </RootErrorBoundary>
    );

    expect(screen.getByText("Desktop ready")).toBeTruthy();
  });
});

function ThrowingChild(): never {
  throw new Error("render failed");
}

function silenceReactError(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "location"
);
