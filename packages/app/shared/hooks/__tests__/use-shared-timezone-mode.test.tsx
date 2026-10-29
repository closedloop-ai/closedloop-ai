import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { FEATURE_FLAG_RESOLUTION_DEADLINE_MS } from "../../feature-flags/use-feature-flag-enabled";
import { TimezoneMode } from "../../lib/date-window-timezone-mode";
import { SESSIONS_BRANCHES_TIMEZONE_MODE_FEATURE_FLAG_KEY } from "../../lib/feature-flags";
import { useSharedTimezoneMode } from "../use-shared-timezone-mode";

const SURFACE = "sessions:test";
const STORAGE_KEY = `shared:timezone-mode:${SURFACE}`;

function wrapperWith(enabledFlags: readonly string[]) {
  const adapter = createStaticFeatureFlagAdapter({ enabledFlags });
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider adapter={adapter}>
      {children}
    </FeatureFlagAdapterProvider>
  );
}

/**
 * An adapter in the state PostHog is actually in between mount and the
 * assignment landing: the flag reads `false` AND reports itself unresolved.
 *
 * Both halves are the defect. `useFeatureFlagEnabled` collapses "not answered
 * yet" into `false`, so this is byte-identical to a genuinely-off assignment —
 * which is precisely why the mode alone cannot tell them apart and readiness has
 * to be reported separately. `createStaticFeatureFlagAdapter` implements no
 * `useFeatureFlagResolved`, so under it every flag reads as already resolved and
 * this window is unreachable.
 */
function unresolvedWrapper() {
  const base = createStaticFeatureFlagAdapter({ enabledFlags: [] });
  const adapter = { ...base, useFeatureFlagResolved: () => false };
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider adapter={adapter}>
      {children}
    </FeatureFlagAdapterProvider>
  );
}

function storeMode(mode: string): void {
  // `useLocalStorageState` JSON-serializes, so seed the same shape it writes.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mode));
}

afterEach(() => {
  localStorage.clear();
  // UNCONDITIONAL: a case that throws between `useFakeTimers` and its restore
  // would otherwise leak a frozen clock into every later test in this worker.
  vi.useRealTimers();
});

describe("useSharedTimezoneMode (ISS-9619)", () => {
  /**
   * The hazard a persisted preference opens, and the reason the flag is read
   * HERE rather than at the toolbar: a reader who chose Local under an open gate
   * must not keep a Local window in a build where the gate is shut, because that
   * build renders no control for them to see or clear it.
   */
  it("pins UTC and offers no writer while the gate is shut", () => {
    storeMode(TimezoneMode.Local);

    const { result } = renderHook(() => useSharedTimezoneMode(SURFACE), {
      wrapper: wrapperWith([]),
    });

    expect(result.current.timezoneMode).toBe(TimezoneMode.Utc);
    expect(result.current.setTimezoneMode).toBeUndefined();
  });

  it("honours the stored choice and offers the writer while the gate is open", () => {
    storeMode(TimezoneMode.Local);

    const { result } = renderHook(() => useSharedTimezoneMode(SURFACE), {
      wrapper: wrapperWith([SESSIONS_BRANCHES_TIMEZONE_MODE_FEATURE_FLAG_KEY]),
    });

    expect(result.current.timezoneMode).toBe(TimezoneMode.Local);
    expect(typeof result.current.setTimezoneMode).toBe("function");
  });

  it("defaults to UTC when nothing is stored", () => {
    const { result } = renderHook(() => useSharedTimezoneMode(SURFACE), {
      wrapper: wrapperWith([SESSIONS_BRANCHES_TIMEZONE_MODE_FEATURE_FLAG_KEY]),
    });

    expect(result.current.timezoneMode).toBe(TimezoneMode.Utc);
  });

  it("falls back to UTC for a stored value outside the vocabulary", () => {
    storeMode("pacific/nowhere");

    const { result } = renderHook(() => useSharedTimezoneMode(SURFACE), {
      wrapper: wrapperWith([SESSIONS_BRANCHES_TIMEZONE_MODE_FEATURE_FLAG_KEY]),
    });

    expect(result.current.timezoneMode).toBe(TimezoneMode.Utc);
  });

  /**
   * ISS-9619 (whitlockk + codex review) — the read gate, and the exact defect it
   * closes. PostHog reports an unresolved assignment as `false`, which this hook
   * cannot tell from a real "off", so a returning reader whose stored mode is
   * `local` reads UTC on the first render. Reporting that render as READY is
   * what let each host key its list AND summary requests to UTC bounds and then
   * refetch under Local once the assignment landed — a transiently wrong
   * population plus a duplicate read on both halves of the surface.
   *
   * Note what this case pins that the mode alone cannot: the mode is UTC in BOTH
   * the unresolved and the genuinely-off state, so only `isTimezoneModeReady`
   * distinguishes them, and only it can hold the read.
   */
  it("reports the mode as not ready while the assignment is unresolved", () => {
    storeMode(TimezoneMode.Local);

    const { result } = renderHook(() => useSharedTimezoneMode(SURFACE), {
      wrapper: unresolvedWrapper(),
    });

    expect(result.current.isTimezoneModeReady).toBe(false);
    // And the mode it would have been read at is the WRONG one — the reader's
    // stored choice is `local` — which is what makes acting on this render a
    // transiently wrong population rather than merely a wasted fetch.
    expect(result.current.timezoneMode).toBe(TimezoneMode.Utc);
  });

  it("reports the mode as ready once the assignment has resolved", () => {
    storeMode(TimezoneMode.Local);

    const { result } = renderHook(() => useSharedTimezoneMode(SURFACE), {
      wrapper: wrapperWith([SESSIONS_BRANCHES_TIMEZONE_MODE_FEATURE_FLAG_KEY]),
    });

    expect(result.current.isTimezoneModeReady).toBe(true);
    expect(result.current.timezoneMode).toBe(TimezoneMode.Local);
  });

  it("reports the mode as ready for a resolved, genuinely-off assignment", () => {
    const { result } = renderHook(() => useSharedTimezoneMode(SURFACE), {
      wrapper: wrapperWith([]),
    });

    expect(result.current.isTimezoneModeReady).toBe(true);
  });

  /**
   * The deadline is the half that keeps this a gate rather than a new way for
   * the board to never load: a flag service that never answers must degrade to
   * the UTC window, not to a permanent skeleton.
   */
  it("opens the gate on the resolution deadline when nothing ever resolves", () => {
    vi.useFakeTimers();
    storeMode(TimezoneMode.Local);

    const { result } = renderHook(() => useSharedTimezoneMode(SURFACE), {
      wrapper: unresolvedWrapper(),
    });

    expect(result.current.isTimezoneModeReady).toBe(false);

    act(() => {
      vi.advanceTimersByTime(FEATURE_FLAG_RESOLUTION_DEADLINE_MS);
    });

    expect(result.current.isTimezoneModeReady).toBe(true);
    // Degraded to the pre-flag window, never to a stalled read.
    expect(result.current.timezoneMode).toBe(TimezoneMode.Utc);
  });
});
