import { beforeEach, describe, expect, it, vi } from "vitest";

const captureMock = vi.fn();
let posthogKey: string | undefined;

vi.mock("@repo/analytics/keys", () => ({
  keys: () => ({ NEXT_PUBLIC_POSTHOG_KEY: posthogKey }),
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    capture: (input: unknown) => {
      captureMock(input);
    },
  },
}));

const CAPTURE_INPUT = {
  event: "command_completed",
  distinctId: "clerk_user_1",
  properties: { command_id: "cmd-1" },
};

// The configured verdict is read once at module load (mirroring the stub
// decision in @repo/analytics/node), so each case imports a fresh module.
async function importCaptureModule() {
  vi.resetModules();
  return await import("../desktop-analytics-capture");
}

describe("captureDesktopAnalytics", () => {
  beforeEach(() => {
    captureMock.mockReset();
  });

  // PRD-736 P1 review finding: with the relay flag's lookup retired, the sink
  // is the only place left that can surface an unconfigured PostHog
  // deployment. Enqueueing into @repo/analytics/node's no-op stub would make
  // the handler ack `accepted: true` — and the REST route answer
  // `200 captured: true` — for an event that was never captured.
  it("throws instead of enqueueing into the unconfigured no-op stub", async () => {
    posthogKey = undefined;
    const { captureDesktopAnalytics } = await importCaptureModule();

    expect(() => captureDesktopAnalytics(CAPTURE_INPUT)).toThrow(
      "PostHog capture sink is not configured"
    );
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("forwards the event to the PostHog client when configured", async () => {
    posthogKey = "phc_test";
    const { captureDesktopAnalytics } = await importCaptureModule();

    captureDesktopAnalytics(CAPTURE_INPUT);

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith(CAPTURE_INPUT);
  });
});
