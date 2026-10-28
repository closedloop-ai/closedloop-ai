// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopOs,
  type DetectedPlatform,
} from "../../lib/desktop-platform-availability";
import { useDetectedDesktopOs } from "../use-detected-desktop-os";

const WINDOWS_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
);

function stubUserAgent(userAgent: string): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent },
    writable: true,
  });
}

afterEach(() => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, "navigator");
});

describe("useDetectedDesktopOs", () => {
  it("answers not-yet-known before it answers a platform", () => {
    // Every render is recorded rather than just the last, because the defect
    // this pins is invisible at the end: seeding the state with a platform
    // default resolves to Windows here too, and only the FIRST commit tells the
    // two apart. That first commit is what a warm query cache paints, and on
    // the setup checklist it is a live anchor to the macOS installer.
    stubUserAgent(WINDOWS_AGENT);
    const seen: (DetectedPlatform | null)[] = [];

    function Probe() {
      seen.push(useDetectedDesktopOs());
      return null;
    }

    render(<Probe />);

    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toBe(DesktopOs.Windows);
  });
});
