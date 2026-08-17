/**
 * ISS-5301: the renderer's macOS platform probes. `isMacOS` decides whether the
 * shell draws its own chrome around the overlaid stoplight buttons, so both of
 * its evidence paths matter — the preload-exposed platform, and the user-agent
 * fallback that keeps the check safe when the bridge is absent (Storybook, a
 * torn-down test global). `macStoplightUnderlayEnabled` additionally gates on
 * the macOS major version, because macOS 26 keeps the buttons rendered on blur
 * and the underlay would double-draw.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  isMacOS,
  macStoplightClearance,
  macStoplightUnderlayEnabled,
} from "../platform";

const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const LINUX_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);
const originalUserAgent = Object.getOwnPropertyDescriptor(
  window.navigator,
  "userAgent"
);

function setDesktopApi(value: unknown): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value,
  });
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  if (originalUserAgent) {
    Object.defineProperty(window.navigator, "userAgent", originalUserAgent);
  } else {
    Reflect.deleteProperty(window.navigator, "userAgent");
  }
});

describe("isMacOS", () => {
  it("trusts the platform the preload bridge exposes", () => {
    setDesktopApi({ platform: "darwin" });
    expect(isMacOS()).toBe(true);

    setDesktopApi({ platform: "linux" });
    expect(isMacOS()).toBe(false);
  });

  it("falls back to the user agent when the bridge is unavailable", () => {
    Reflect.deleteProperty(window, "desktopApi");

    setUserAgent(MAC_USER_AGENT);
    expect(isMacOS()).toBe(true);

    setUserAgent(LINUX_USER_AGENT);
    expect(isMacOS()).toBe(false);
  });

  it("falls back to the user agent when the bridge reports no platform", () => {
    setDesktopApi({});

    setUserAgent(MAC_USER_AGENT);
    expect(isMacOS()).toBe(true);
  });
});

describe("macStoplightClearance", () => {
  it("returns the clearance class on macOS and false elsewhere", () => {
    setDesktopApi({ platform: "darwin" });
    // Shaped for `cn()`: the class itself, not a boolean.
    expect(macStoplightClearance()).toBe("pl-[5.25rem]");

    setDesktopApi({ platform: "win32" });
    expect(macStoplightClearance()).toBe(false);
  });
});

describe("macStoplightUnderlayEnabled", () => {
  it("is off entirely when this is not macOS", () => {
    setDesktopApi({ platform: "linux", macOSMajorVersion: 15 });

    expect(macStoplightUnderlayEnabled()).toBe(false);
  });

  it("renders on pre-Tahoe macOS, where Electron drops the buttons on blur", () => {
    setDesktopApi({ platform: "darwin", macOSMajorVersion: 25 });

    expect(macStoplightUnderlayEnabled()).toBe(true);
  });

  it("stops rendering on macOS 26+, which keeps the buttons dimmed instead", () => {
    setDesktopApi({ platform: "darwin", macOSMajorVersion: 26 });

    expect(macStoplightUnderlayEnabled()).toBe(false);
  });

  it("keeps the historical behavior when the version is unknown", () => {
    setDesktopApi({ platform: "darwin" });

    expect(macStoplightUnderlayEnabled()).toBe(true);
  });
});
