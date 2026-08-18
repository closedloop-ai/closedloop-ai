// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrototypeCommentsControl } from "./use-prototype-comments-control";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePrototypeCommentsControl", () => {
  it("keeps the comments rail closed by default at narrow viewports", () => {
    stubMatchMedia(false);

    const { result } = renderHook(() =>
      usePrototypeCommentsControl("branch-a")
    );

    expect(result.current.open).toBe(false);
  });

  it("keeps the comments rail open by default at wide viewports", () => {
    stubMatchMedia(true);

    const { result } = renderHook(() =>
      usePrototypeCommentsControl("branch-a")
    );

    expect(result.current.open).toBe(true);
  });

  it("resets a manual choice across branch and list transitions", () => {
    stubMatchMedia(false);
    const initialProps: { identity: string | null } = {
      identity: "branch-a",
    };
    const { rerender, result } = renderHook(
      ({ identity }: { identity: string | null }) =>
        usePrototypeCommentsControl(identity),
      { initialProps }
    );

    act(() => result.current.onOpenChange(true));
    expect(result.current.open).toBe(true);

    rerender({ identity: "branch-b" });
    expect(result.current.open).toBe(false);

    rerender({ identity: "branch-a" });
    expect(result.current.open).toBe(false);

    act(() => result.current.onOpenChange(true));
    rerender({ identity: null });
    rerender({ identity: "branch-a" });
    expect(result.current.open).toBe(false);
  });
});

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches,
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }) as MediaQueryList
  );
}
