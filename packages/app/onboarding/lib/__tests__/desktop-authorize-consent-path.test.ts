import { DESKTOP_AUTHORIZE_PATHNAME } from "@repo/api/src/types/desktop-authorize-url";
import { describe, expect, it } from "vitest";
import { isDesktopAuthorizeConsentPath } from "../desktop-authorize-consent-path";

describe("isDesktopAuthorizeConsentPath", () => {
  it("matches the bare authorize path the desktop opens", () => {
    expect(isDesktopAuthorizeConsentPath(DESKTOP_AUTHORIZE_PATHNAME)).toBe(
      true
    );
  });

  it("matches the org-scoped form the proxy rewrites to", () => {
    expect(
      isDesktopAuthorizeConsentPath(`/acme${DESKTOP_AUTHORIZE_PATHNAME}`)
    ).toBe(true);
  });

  it("does not match the desktop connect page beside it", () => {
    expect(
      isDesktopAuthorizeConsentPath(
        "/acme/settings/integrations/desktop/connect"
      )
    ).toBe(false);
  });

  it("does not match a path that only shares the final segment", () => {
    expect(isDesktopAuthorizeConsentPath("/acme/settings/authorize")).toBe(
      false
    );
  });

  it("does not match ordinary authenticated routes", () => {
    expect(isDesktopAuthorizeConsentPath("/acme/dashboard")).toBe(false);
    expect(isDesktopAuthorizeConsentPath("/")).toBe(false);
  });
});
