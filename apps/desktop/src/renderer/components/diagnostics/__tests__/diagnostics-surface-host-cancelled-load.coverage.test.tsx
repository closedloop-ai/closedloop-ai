/**
 * ISS-11284 coverage — `DiagnosticsSurfaceHost`'s polling loop's `stopped`
 * guard (`if (!stopped) tick();`, ~L170).
 *
 * `diagnostics-surface-host.test.tsx` proves the host's read/poll/gate
 * behavior while it stays mounted; none of its cases unmount mid-flight, so
 * the branch where a firing poll finds the component already gone is
 * unexercised. This case drives exactly that.
 *
 * The `load` function's three `!cancelled.current` guards (success/error/
 * finally, ~L113/L118/L123) are deliberately NOT covered here. `useCancelledRef`
 * only sets `cancelled.current = true` in the unmount cleanup of an
 * empty-deps effect, so the only way to reach those branches with the guard
 * live is a real unmount — and past that point every guarded action is a bare
 * `setState` (or `settleLoad`'s ref increment, itself unread once unmounted)
 * with no other side effect. React 18's `createRoot` silently drops a
 * post-unmount state update: no warning, no exception, nothing to assert on.
 * Verified directly: with all three guards removed from the source, the two
 * "settle after unmount" cases that used to live in this file stayed green,
 * because nothing distinguished a guarded drop from an unguarded one. Those
 * cases are removed rather than kept vacuous.
 */

import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsSurfaceHost } from "../diagnostics-surface-host";

const AUTO_REFRESH_MS = 5000;
const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

let getDiagnostics: ReturnType<typeof vi.fn>;

function diagnosticsPayload() {
  return { generatedAt: "2026-09-22T00:00:00.000Z", repos: [], sessions: [] };
}

function installDesktopApi(): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: { getDiagnostics },
      getLogs: vi.fn(async () => []),
      clearLogs: vi.fn(async () => undefined),
      openLogFile: vi.fn(async () => ({ ok: true })),
      onLogsChanged: vi.fn(() => () => undefined),
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  getDiagnostics = vi.fn(async () => diagnosticsPayload());
  installDesktopApi();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

function mount() {
  const adapter = createStaticFeatureFlagAdapter({ enabledFlags: [] });
  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      <DiagnosticsSurfaceHost isActive={true} />
    </FeatureFlagAdapterProvider>
  );
}

describe("DiagnosticsSurfaceHost — the poll loop stops cleanly (L170)", () => {
  it("does not reschedule the next tick once torn down mid-flight", async () => {
    let resolveSecondRead: (() => void) | null = null;
    getDiagnostics
      .mockImplementationOnce(async () => diagnosticsPayload())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondRead = () => resolve(diagnosticsPayload());
          })
      );
    const view = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getDiagnostics).toHaveBeenCalledTimes(1);

    // Fire the poll's setTimeout: the recursive `tick` callback is now
    // suspended on `await load()`, with `stopped` still false.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_MS);
    });
    expect(getDiagnostics).toHaveBeenCalledTimes(2);

    // Tear down WHILE that second read is still in flight: the effect's
    // cleanup sets `stopped = true` before the pending `load()` resolves.
    view.unmount();

    await act(async () => {
      resolveSecondRead?.();
      await vi.advanceTimersByTimeAsync(1);
    });

    // With `stopped` true, `if (!stopped) tick();` (L170) does NOT reschedule.
    // Advancing well past another interval must not produce a third read —
    // proof the loop actually stopped rather than merely being unobserved.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_MS * 3);
    });
    expect(getDiagnostics).toHaveBeenCalledTimes(2);
  });
});
