import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStartSessionRecording = vi.fn();
const mockStopSessionRecording = vi.fn();
const mockSetConfig = vi.fn();
const mockEnableDatadog = vi.fn();
const mockDisableDatadog = vi.fn();

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

vi.mock("@repo/analytics/client", () => ({
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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useFrontendCaptureGate", () => {
  it("starts staff capture on both backends when the flag is enabled", async () => {
    const useFrontendCaptureGate = await loadHook();

    renderHook(() => useFrontendCaptureGate());

    expect(mockStartSessionRecording).toHaveBeenCalledTimes(1);
    expect(mockSetConfig).toHaveBeenCalledWith({ capture_dead_clicks: true });
    expect(mockEnableDatadog).toHaveBeenCalledWith("user-123");
  });

  it("does nothing when the flag is disabled", async () => {
    mockFlagEnabled = false;
    const useFrontendCaptureGate = await loadHook();

    renderHook(() => useFrontendCaptureGate());

    expect(mockStartSessionRecording).not.toHaveBeenCalled();
    expect(mockEnableDatadog).not.toHaveBeenCalled();
  });

  it("fails closed for a non-staff user even when the flag reads enabled", async () => {
    // Simulates the fail-open flag fallback (PostHog unconfigured → flag
    // defaults enabled): the staff-email guard must still block capture.
    mockUser = {
      id: "user-999",
      primaryEmailAddress: { emailAddress: "customer@acme.com" },
    };
    mockFlagEnabled = true;
    const useFrontendCaptureGate = await loadHook();

    renderHook(() => useFrontendCaptureGate());

    expect(mockStartSessionRecording).not.toHaveBeenCalled();
    expect(mockEnableDatadog).not.toHaveBeenCalled();
  });

  it("does nothing until the user is identified", async () => {
    mockUser = null;
    const useFrontendCaptureGate = await loadHook();

    renderHook(() => useFrontendCaptureGate());

    expect(mockStartSessionRecording).not.toHaveBeenCalled();
    expect(mockEnableDatadog).not.toHaveBeenCalled();
  });

  it("stops all added capture when unmounted", async () => {
    const useFrontendCaptureGate = await loadHook();

    const { unmount } = renderHook(() => useFrontendCaptureGate());
    unmount();

    expect(mockStopSessionRecording).toHaveBeenCalledTimes(1);
    expect(mockSetConfig).toHaveBeenCalledWith({ capture_dead_clicks: false });
    expect(mockDisableDatadog).toHaveBeenCalledTimes(1);
  });
});
