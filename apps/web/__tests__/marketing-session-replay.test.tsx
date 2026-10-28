// @vitest-environment jsdom

import { WEB_FRONTEND_CAPTURE_FLAG_KEY } from "@repo/api/src/types/web-frontend-capture-flag";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postHogConfigured: true,
  freshValue: undefined as boolean | undefined,
  flagReads: [] as string[],
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
  setConfig: vi.fn(),
}));

/** posthog-js hands out one module singleton, so the stub is stable too. */
const posthog = vi.hoisted(() => ({
  startSessionRecording: () => mocks.startSessionRecording(),
  stopSessionRecording: () => mocks.stopSessionRecording(),
  set_config: (config: unknown) => mocks.setConfig(config),
}));

/**
 * `useFeatureFlag` and `useFeatureFlagProductionValue` answer OPEN for every
 * flag here, standing in for the QA fail-open, the E2E fixture, a Dev Mode
 * override and a value persisted on an earlier visit. Only this page load's
 * `/flags` answer (`useFeatureFlagFreshValue`, covered against a real
 * posthog-js in `packages/analytics/feature-flag-fresh-value.test.tsx`) may
 * start a replay.
 */
vi.mock("@repo/analytics/client", () => ({
  get postHogFeatureFlagsEnabled() {
    return mocks.postHogConfigured;
  },
  useAnalytics: () => posthog,
  useFeatureFlag: (flag: string) => ({ key: flag, enabled: true }),
  useFeatureFlagProductionValue: () => true,
  useFeatureFlagFreshValue: (flag: string) => {
    mocks.flagReads.push(flag);
    return mocks.freshValue;
  },
}));

const { MarketingSessionReplay } = await import(
  "@/components/marketing-session-replay"
);

beforeEach(() => {
  mocks.postHogConfigured = true;
  mocks.freshValue = undefined;
  mocks.flagReads = [];
  mocks.startSessionRecording.mockReset();
  mocks.stopSessionRecording.mockReset();
  mocks.setConfig.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("marketing session replay (ISS-12558)", () => {
  test("starts for a visitor PostHog assigns the web-app capture flag", () => {
    mocks.freshValue = true;

    render(<MarketingSessionReplay />);

    expect(mocks.flagReads).toContain(WEB_FRONTEND_CAPTURE_FLAG_KEY);
    expect(mocks.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(mocks.setConfig).toHaveBeenCalledWith({ capture_dead_clicks: true });
  });

  test("does not start from a fallback while PostHog has not answered", () => {
    render(<MarketingSessionReplay />);

    expect(mocks.startSessionRecording).not.toHaveBeenCalled();
  });

  test("never starts when the fresh answer turns out OFF", () => {
    const { rerender } = render(<MarketingSessionReplay />);

    mocks.freshValue = false;
    rerender(<MarketingSessionReplay />);

    expect(mocks.startSessionRecording).not.toHaveBeenCalled();
  });

  test("does not start when PostHog turns the flag off for the visitor", () => {
    mocks.freshValue = false;

    render(<MarketingSessionReplay />);

    expect(mocks.startSessionRecording).not.toHaveBeenCalled();
  });

  test("fails closed when PostHog is unconfigured", () => {
    mocks.postHogConfigured = false;
    mocks.freshValue = true;

    render(<MarketingSessionReplay />);

    expect(mocks.startSessionRecording).not.toHaveBeenCalled();
  });

  test("stops when the flag turns off for the visitor", () => {
    mocks.freshValue = true;
    const { rerender } = render(<MarketingSessionReplay />);

    mocks.freshValue = false;
    rerender(<MarketingSessionReplay />);

    expect(mocks.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(mocks.setConfig).toHaveBeenLastCalledWith({
      capture_dead_clicks: false,
    });
  });

  test("starts once across rerenders and stops on unmount", () => {
    mocks.freshValue = true;
    const { rerender, unmount } = render(<MarketingSessionReplay />);

    rerender(<MarketingSessionReplay />);
    expect(mocks.startSessionRecording).toHaveBeenCalledTimes(1);

    unmount();
    expect(mocks.stopSessionRecording).toHaveBeenCalledTimes(1);
  });
});
