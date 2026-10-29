/**
 * ISS-8351 / PLN-1875 Step 4: the promoted reduced-motion hook. It is a wrapper
 * over `useMediaQuery`, so what is worth pinning is the query it asks for — a
 * typo there reads as "nobody wants reduced motion" and every motion suppressor
 * downstream stays silently off.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrefersReducedMotion } from "../use-prefers-reduced-motion";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const originalDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "matchMedia"
);

function stubMatchMedia(matches: (query: string) => boolean) {
  const calls: string[] = [];
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      calls.push(query);
      return {
        matches: matches(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    },
  });
  return calls;
}

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, "matchMedia", originalDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "matchMedia");
  }
});

describe("usePrefersReducedMotion", () => {
  it("asks for the reduced-motion preference and reports it as set", () => {
    const calls = stubMatchMedia((query) => query === REDUCED_MOTION_QUERY);

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(calls).toContain(REDUCED_MOTION_QUERY);
    expect(result.current).toBe(true);
  });

  it("reports false when the preference is not set", () => {
    stubMatchMedia(() => false);

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);
  });
});
