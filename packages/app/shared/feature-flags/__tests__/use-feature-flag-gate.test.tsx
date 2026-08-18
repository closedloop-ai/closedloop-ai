import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlagAdapter } from "../feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "../provider";
import {
  FEATURE_FLAG_RESOLUTION_DEADLINE_MS,
  useFeatureFlagGate,
} from "../use-feature-flag-enabled";

// FEA-1626 (wongk): `useFeatureFlagEnabled` collapses "not loaded yet" into
// `false`, which is right for rendering and wrong for a data read — a surface
// that keys its REQUEST off a flag would fetch on the closed default and refetch
// once the flag landed. `useFeatureFlagGate` exposes the difference, bounded so a
// flag service that never answers degrades to the closed default instead of an
// endless skeleton.

const FLAG = "some-flag";

function Probe() {
  const { enabled, isReady } = useFeatureFlagGate(FLAG);
  return (
    <div
      data-enabled={enabled ? "true" : "false"}
      data-ready={isReady ? "true" : "false"}
      data-testid="probe"
    />
  );
}

function renderWithAdapter(adapter: FeatureFlagAdapter) {
  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      <Probe />
    </FeatureFlagAdapterProvider>
  );
}

function readProbe() {
  const probe = screen.getByTestId("probe");
  return {
    enabled: probe.getAttribute("data-enabled"),
    ready: probe.getAttribute("data-ready"),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useFeatureFlagGate", () => {
  it("is NOT ready while an async adapter has not resolved the flag", () => {
    renderWithAdapter({
      useFeatureFlagEnabled: () => false,
      useFeatureFlagResolved: () => false,
    });

    expect(readProbe()).toEqual({ enabled: "false", ready: "false" });
  });

  it("is ready, and enabled, once the adapter resolves the flag on", () => {
    renderWithAdapter({
      useFeatureFlagEnabled: () => true,
      useFeatureFlagResolved: () => true,
    });

    expect(readProbe()).toEqual({ enabled: "true", ready: "true" });
  });

  it("is ready immediately for an adapter with no async resolution to report", () => {
    // The desktop Labs adapter and the static test adapter resolve
    // synchronously, so omitting the optional hook must read as resolved rather
    // than blocking their surfaces forever.
    renderWithAdapter({ useFeatureFlagEnabled: () => false });

    expect(readProbe()).toEqual({ enabled: "false", ready: "true" });
  });

  it("proceeds on the closed default once the resolution deadline passes", () => {
    renderWithAdapter({
      useFeatureFlagEnabled: () => false,
      useFeatureFlagResolved: () => false,
    });

    expect(readProbe().ready).toBe("false");

    act(() => {
      vi.advanceTimersByTime(FEATURE_FLAG_RESOLUTION_DEADLINE_MS);
    });

    // A PostHog outage must degrade to the pre-flag screen, never to no screen.
    expect(readProbe()).toEqual({ enabled: "false", ready: "true" });
  });

  it("does not wait out the deadline when the flag resolves first", () => {
    renderWithAdapter({
      useFeatureFlagEnabled: () => true,
      useFeatureFlagResolved: () => true,
    });

    act(() => {
      vi.advanceTimersByTime(FEATURE_FLAG_RESOLUTION_DEADLINE_MS * 2);
    });

    expect(readProbe()).toEqual({ enabled: "true", ready: "true" });
  });
});
