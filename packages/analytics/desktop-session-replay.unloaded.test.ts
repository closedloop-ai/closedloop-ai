import posthog from "posthog-js/dist/module.full.no-external";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discardDesktopSessionReplay } from "./desktop-session-replay";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discardDesktopSessionReplay before any start (ISS-12257)", () => {
  it("does not touch posthog-js when replay was never started", () => {
    const stop = vi.spyOn(posthog, "stopSessionRecording");

    discardDesktopSessionReplay();

    expect(posthog.__loaded).toBeFalsy();
    expect(stop).not.toHaveBeenCalled();
  });
});
