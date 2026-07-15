import { describe, expect, it } from "vitest";
import {
  buildDesktopReturnUrl,
  DESKTOP_RETURN_PROTOCOL,
} from "../desktop-return";

describe("buildDesktopReturnUrl", () => {
  it("carries only the non-secret code and status", () => {
    const url = new URL(
      buildDesktopReturnUrl({ userCode: "ABCD1234", status: "approved" })
    );

    expect(url.protocol).toBe(DESKTOP_RETURN_PROTOCOL);
    expect(url.searchParams.get("code")).toBe("ABCD1234");
    expect(url.searchParams.get("status")).toBe("approved");
    expect([...url.searchParams.keys()].sort()).toEqual(["code", "status"]);
  });

  it("never leaks secret/exchange material into the return channel", () => {
    // Even if the detail object grows secret-looking fields, the builder reads
    // only userCode + status, so nothing sensitive can reach the desktop via
    // the (hijackable) custom-protocol link. (FEA-2218 acceptance criterion.)
    const tainted = {
      userCode: "ABCD1234",
      status: "approved",
      deviceSessionSecret: "super-secret-device-session-value",
      refreshToken: "rt_should_never_appear",
      accessToken: "at_should_never_appear",
      exchangeToken: "xt_should_never_appear",
      authorization: "Bearer should-never-appear",
      verifier: "pkce-verifier-should-never-appear",
    } as unknown as { userCode: string; status: string };

    const result = buildDesktopReturnUrl(tainted);

    for (const secret of [
      "super-secret-device-session-value",
      "rt_should_never_appear",
      "at_should_never_appear",
      "xt_should_never_appear",
      "should-never-appear",
      "pkce-verifier-should-never-appear",
      "deviceSessionSecret",
      "refreshToken",
      "accessToken",
      "exchangeToken",
      "authorization",
      "verifier",
    ]) {
      expect(result).not.toContain(secret);
    }
  });
});
