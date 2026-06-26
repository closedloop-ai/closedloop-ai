import { describe, expect, it } from "vitest";
import { shouldRunAmbientDesktopBootstrap } from "./ambient-desktop-routes";

describe("shouldRunAmbientDesktopBootstrap", () => {
  it("disables ambient desktop probing on insights routes", () => {
    expect(shouldRunAmbientDesktopBootstrap("/closedloop-ai/insights")).toBe(
      false
    );
    expect(
      shouldRunAmbientDesktopBootstrap("/closedloop-ai/insights/delivery")
    ).toBe(false);
  });

  it("keeps ambient desktop probing enabled on execution-oriented routes", () => {
    expect(shouldRunAmbientDesktopBootstrap("/closedloop-ai/build/123")).toBe(
      true
    );
    expect(
      shouldRunAmbientDesktopBootstrap("/closedloop-ai/implementation-plans")
    ).toBe(true);
    expect(shouldRunAmbientDesktopBootstrap(null)).toBe(true);
  });
});
