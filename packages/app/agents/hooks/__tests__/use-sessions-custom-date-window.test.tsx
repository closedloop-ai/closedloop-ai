import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useFeatureFlagGate: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagGate: mocks.useFeatureFlagGate,
}));

import { useSessionsCustomDateWindow } from "../use-sessions-custom-date-window";

const FLAG_KEY = "sessions-custom-date-window";
const ROUTE_PATH = "/sessions";
const WINDOW_QUERY = "from=2026-01-01&to=2026-01-08";
const EXPECTED_WINDOW = { from: "2026-01-01", to: "2026-01-08" };

function setGate(enabled: boolean, isReady: boolean): void {
  mocks.useFeatureFlagGate.mockReturnValue({
    enabled,
    isReady,
    isResolved: isReady,
  });
}

function renderWindow(initialQuery: string) {
  return renderHook(
    ({ query }: { query: string }) =>
      useSessionsCustomDateWindow(
        FLAG_KEY,
        new URLSearchParams(query),
        ROUTE_PATH
      ),
    { initialProps: { query: initialQuery } }
  );
}

describe("useSessionsCustomDateWindow", () => {
  let previousHref: string;

  beforeEach(() => {
    previousHref = globalThis.location.href;
    mocks.useFeatureFlagGate.mockReset();
  });

  afterEach(() => {
    globalThis.history.replaceState(null, "", previousHref);
  });

  it("resolves the URL window and hands the setter through when enabled", () => {
    setGate(true, true);
    const setter = vi.fn();

    const { result } = renderWindow(WINDOW_QUERY);

    expect(mocks.useFeatureFlagGate).toHaveBeenCalledWith(FLAG_KEY);
    expect(result.current.customDateWindow).toEqual(EXPECTED_WINDOW);
    expect(result.current.gateCustomDateWindowChange(setter)).toBe(setter);
    expect(result.current.isCustomDateWindowReady).toBe(true);
  });

  it("treats the params as inert and withholds the setter when disabled", () => {
    setGate(false, true);

    const { result } = renderWindow(WINDOW_QUERY);

    expect(result.current.customDateWindow).toBeNull();
    expect(result.current.gateCustomDateWindowChange(vi.fn())).toBeUndefined();
  });

  it("is not ready while the flag is unresolved and the URL names a window", () => {
    setGate(false, false);

    const { result } = renderWindow(WINDOW_QUERY);

    expect(result.current.isCustomDateWindowReady).toBe(false);
  });

  it("is ready before the flag resolves when the URL names no window", () => {
    setGate(false, false);

    const { result } = renderWindow("");

    expect(result.current.isCustomDateWindowReady).toBe(true);
  });

  it("reads the mount-time browser URL while the snapshot is still empty", () => {
    globalThis.history.replaceState(null, "", `${ROUTE_PATH}?${WINDOW_QUERY}`);
    setGate(true, true);

    const { result } = renderWindow("");

    expect(result.current.customDateWindow).toEqual(EXPECTED_WINDOW);
  });

  it("ignores the browser URL when it is on a different route", () => {
    globalThis.history.replaceState(null, "", `/branches?${WINDOW_QUERY}`);
    setGate(true, true);

    const { result } = renderWindow("");

    expect(result.current.customDateWindow).toBeNull();
  });

  it("trusts an emptied snapshot once it has carried params", () => {
    globalThis.history.replaceState(null, "", `${ROUTE_PATH}?${WINDOW_QUERY}`);
    setGate(true, true);

    const { result, rerender } = renderWindow("from=2026-02-01&to=2026-02-02");
    expect(result.current.customDateWindow).toEqual({
      from: "2026-02-01",
      to: "2026-02-02",
    });

    rerender({ query: "" });

    expect(result.current.customDateWindow).toBeNull();
  });
});
