import { afterEach, describe, expect, it, vi } from "vitest";

const mockSetUser = vi.fn();
const mockClearUser = vi.fn();
const mockStartReplay = vi.fn();
const mockStopReplay = vi.fn();

vi.mock("@datadog/browser-rum", () => ({
  datadogRum: {
    setUser: mockSetUser,
    clearUser: mockClearUser,
    startSessionReplayRecording: mockStartReplay,
    stopSessionReplayRecording: mockStopReplay,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadModules() {
  const staffCapture = await import("@/lib/datadog-rum/staff-capture");
  const config = await import("@/lib/datadog-rum/config");
  return { ...staffCapture, ...config };
}

describe("Datadog RUM staff capture", () => {
  it("enables egress and attaches the user id without starting replay", async () => {
    const { enableDatadogRumStaffCapture, isDatadogRumStaffCaptureEnabled } =
      await loadModules();

    enableDatadogRumStaffCapture("user-123");

    expect(isDatadogRumStaffCaptureEnabled()).toBe(true);
    expect(mockSetUser).toHaveBeenCalledWith({ id: "user-123" });
    // ISS-12356(f): session replay is off for staff sessions too.
    expect(mockStartReplay).not.toHaveBeenCalled();
  });

  it("disables egress and clears the user", async () => {
    const {
      enableDatadogRumStaffCapture,
      disableDatadogRumStaffCapture,
      isDatadogRumStaffCaptureEnabled,
    } = await loadModules();

    enableDatadogRumStaffCapture("user-123");
    disableDatadogRumStaffCapture();

    expect(isDatadogRumStaffCaptureEnabled()).toBe(false);
    expect(mockStopReplay).not.toHaveBeenCalled();
    expect(mockClearUser).toHaveBeenCalledTimes(1);
  });

  it("never throws when the RUM SDK fails", async () => {
    mockSetUser.mockImplementationOnce(() => {
      throw new Error("sdk not ready");
    });
    const { enableDatadogRumStaffCapture } = await loadModules();

    expect(() => enableDatadogRumStaffCapture("user-123")).not.toThrow();
  });
});
