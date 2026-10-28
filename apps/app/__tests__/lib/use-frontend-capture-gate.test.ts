import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";

const mockStartSessionRecording = vi.fn();
const mockStopSessionRecording = vi.fn();
const mockSetConfig = vi.fn();
const mockEnableDatadog = vi.fn();
const mockDisableDatadog = vi.fn();
const mockPostHogConfigured = vi.hoisted(() => ({ value: true }));

type MockUser = {
  id: string;
  primaryEmailAddress?: { emailAddress?: string };
} | null;
const STAFF_USER: MockUser = {
  id: "user-123",
  primaryEmailAddress: { emailAddress: "dev@closedloop.ai" },
};
let mockUser: MockUser = STAFF_USER;
let mockIsLoaded = true;
let mockFlagEnabled = true;
let mockFlagsSettledForUser = true;

vi.mock("@repo/analytics/client", () => ({
  get postHogFeatureFlagsEnabled() {
    return mockPostHogConfigured.value;
  },
  useAnalytics: () => ({
    identify: vi.fn(),
    capture: vi.fn(),
    reset: vi.fn(),
    startSessionRecording: mockStartSessionRecording,
    stopSessionRecording: mockStopSessionRecording,
    set_config: mockSetConfig,
  }),
  useFeatureFlag: (flag: string) => ({
    key: flag,
    enabled: mockFlagEnabled,
    variant: undefined,
    payload: undefined,
  }),
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => ({ user: mockUser, isLoaded: mockIsLoaded }),
}));

vi.mock("@/components/feature-flags-settled", () => ({
  useFeatureFlagsSettledForUser: () => mockFlagsSettledForUser,
}));

vi.mock("@/lib/datadog-rum/staff-capture", () => ({
  enableDatadogRumStaffCapture: mockEnableDatadog,
  disableDatadogRumStaffCapture: mockDisableDatadog,
}));

async function loadHook() {
  return (await import("@/lib/frontend-capture/use-frontend-capture-gate"))
    .useFrontendCaptureGate;
}

beforeEach(() => {
  mockUser = STAFF_USER;
  mockIsLoaded = true;
  mockFlagEnabled = true;
  mockFlagsSettledForUser = true;
  mockPostHogConfigured.value = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useFrontendCaptureGate", () => {
  it("starts PostHog and Datadog capture for flagged staff users", async () => {
    const useFrontendCaptureGate = await loadHook();

    renderHook(() => useFrontendCaptureGate(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(mockStartSessionRecording).toHaveBeenCalledTimes(1);
    expect(mockSetConfig).toHaveBeenCalledWith({ capture_dead_clicks: true });
    expect(mockEnableDatadog).toHaveBeenCalledWith("user-123");
  });

  it("does nothing when the flag is disabled", async () => {
    mockFlagEnabled = false;
    const useFrontendCaptureGate = await loadHook();

    renderHook(() => useFrontendCaptureGate(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(mockStartSessionRecording).not.toHaveBeenCalled();
    expect(mockEnableDatadog).not.toHaveBeenCalled();
  });

  it("starts PostHog but keeps Datadog staff-scoped for flagged customers", async () => {
    mockUser = {
      id: "user-999",
      primaryEmailAddress: { emailAddress: "customer@acme.com" },
    };
    mockFlagEnabled = true;
    const useFrontendCaptureGate = await loadHook();

    renderHook(() => useFrontendCaptureGate(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(mockStartSessionRecording).toHaveBeenCalledTimes(1);
    expect(mockEnableDatadog).not.toHaveBeenCalled();
  });

  it("fails closed when PostHog is unconfigured", async () => {
    mockPostHogConfigured.value = false;
    const useFrontendCaptureGate = await loadHook();

    renderHook(() => useFrontendCaptureGate(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(mockStartSessionRecording).not.toHaveBeenCalled();
    expect(mockEnableDatadog).not.toHaveBeenCalled();
  });

  it("does nothing until the user is identified", async () => {
    mockUser = null;
    const useFrontendCaptureGate = await loadHook();

    renderHook(() => useFrontendCaptureGate(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(mockStartSessionRecording).not.toHaveBeenCalled();
    expect(mockEnableDatadog).not.toHaveBeenCalled();
  });

  it("does not record from an anonymous flag before the user's flags settle", async () => {
    mockFlagsSettledForUser = false;
    mockFlagEnabled = true;
    const useFrontendCaptureGate = await loadHook();

    const { rerender } = renderHook(() => useFrontendCaptureGate(), {
      wrapper: WebFeatureFlagProvider,
    });

    expect(mockStartSessionRecording).not.toHaveBeenCalled();

    mockFlagsSettledForUser = true;
    mockFlagEnabled = false;
    rerender();

    expect(mockStartSessionRecording).not.toHaveBeenCalled();
    expect(mockEnableDatadog).not.toHaveBeenCalled();
  });

  it("stops all added capture when unmounted", async () => {
    const useFrontendCaptureGate = await loadHook();

    const { unmount } = renderHook(() => useFrontendCaptureGate(), {
      wrapper: WebFeatureFlagProvider,
    });
    unmount();

    expect(mockStopSessionRecording).toHaveBeenCalledTimes(1);
    expect(mockSetConfig).toHaveBeenCalledWith({ capture_dead_clicks: false });
    expect(mockDisableDatadog).toHaveBeenCalledTimes(1);
  });

  it("does not touch Datadog when a customer capture unmounts", async () => {
    mockUser = {
      id: "user-999",
      primaryEmailAddress: { emailAddress: "customer@acme.com" },
    };
    const useFrontendCaptureGate = await loadHook();

    const { unmount } = renderHook(() => useFrontendCaptureGate(), {
      wrapper: WebFeatureFlagProvider,
    });
    unmount();

    expect(mockStopSessionRecording).toHaveBeenCalledTimes(1);
    expect(mockDisableDatadog).not.toHaveBeenCalled();
  });
});
