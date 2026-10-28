import { DESKTOP_AUTHORIZE_PATHNAME } from "@repo/api/src/types/desktop-authorize-url";
import { describe, expect, it } from "vitest";
import {
  buildDesktopOrgReturnHref,
  DESKTOP_ORG_RETURN_PARAM,
  DESKTOP_ORG_RETURN_PATHNAME,
  isDesktopAuthorizeRunPathname,
  resolveDesktopAuthorizeReturnTarget,
} from "../desktop-org-return";

const APP_ORIGIN = "https://app.closedloop.ai";

/**
 * A representative desktop authorize query: PKCE challenge, opaque state, the
 * loopback `redirect_uri`, and the base64url gateway key. Losing any of it
 * strands the desktop on its loopback listener.
 */
const AUTHORIZE_SEARCH =
  "?code_challenge=abc123&code_challenge_method=S256&state=xyz789" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A51789%2Fcallback" +
  "&gateway_id=gw-1&gateway_public_key=LS0tLS1CRUdJTg";

describe("isDesktopAuthorizeRunPathname", () => {
  it("recognizes the bare and the org-scoped authorize paths", () => {
    expect(isDesktopAuthorizeRunPathname(DESKTOP_AUTHORIZE_PATHNAME)).toBe(
      true
    );
    expect(
      isDesktopAuthorizeRunPathname(`/acme${DESKTOP_AUTHORIZE_PATHNAME}`)
    ).toBe(true);
  });

  it("does not recognize a deeper path that merely ends in the authorize path", () => {
    expect(
      isDesktopAuthorizeRunPathname(`/acme/nested${DESKTOP_AUTHORIZE_PATHNAME}`)
    ).toBe(false);
    expect(
      isDesktopAuthorizeRunPathname(`${DESKTOP_AUTHORIZE_PATHNAME}/extra`)
    ).toBe(false);
  });

  it("does not recognize an ordinary app route", () => {
    expect(isDesktopAuthorizeRunPathname("/acme/dashboard")).toBe(false);
    expect(isDesktopAuthorizeRunPathname("/acme/settings")).toBe(false);
  });
});

describe("resolveDesktopAuthorizeReturnTarget", () => {
  it("keeps the authorize path and its whole query", () => {
    expect(
      resolveDesktopAuthorizeReturnTarget(
        `${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`,
        APP_ORIGIN
      )
    ).toBe(`${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`);
  });

  it("accepts the org-scoped spelling the proxy produces", () => {
    expect(
      resolveDesktopAuthorizeReturnTarget(
        `/acme${DESKTOP_AUTHORIZE_PATHNAME}?state=xyz`,
        APP_ORIGIN
      )
    ).toBe(`/acme${DESKTOP_AUTHORIZE_PATHNAME}?state=xyz`);
  });

  it("rejects a same-origin path that is not the authorize page", () => {
    expect(
      resolveDesktopAuthorizeReturnTarget("/acme/dashboard", APP_ORIGIN)
    ).toBeNull();
    expect(
      resolveDesktopAuthorizeReturnTarget("/acme/settings", APP_ORIGIN)
    ).toBeNull();
  });

  it("rejects every off-origin shape, including the ones that look rooted", () => {
    for (const hostile of [
      `https://evil.test${DESKTOP_AUTHORIZE_PATHNAME}`,
      `//evil.test${DESKTOP_AUTHORIZE_PATHNAME}`,
      String.raw`/\evil.test` + DESKTOP_AUTHORIZE_PATHNAME,
      "javascript:alert(1)",
    ]) {
      expect(
        resolveDesktopAuthorizeReturnTarget(hostile, APP_ORIGIN)
      ).toBeNull();
    }
  });

  it("rejects an absent target", () => {
    expect(resolveDesktopAuthorizeReturnTarget(null, APP_ORIGIN)).toBeNull();
    expect(resolveDesktopAuthorizeReturnTarget("", APP_ORIGIN)).toBeNull();
  });
});

describe("buildDesktopOrgReturnHref", () => {
  it("points at the server hop with the target encoded as a single param", () => {
    const href = buildDesktopOrgReturnHref(
      `${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`
    );
    const url = new URL(href, APP_ORIGIN);

    expect(url.pathname).toBe(DESKTOP_ORG_RETURN_PATHNAME);
    expect(url.searchParams.get(DESKTOP_ORG_RETURN_PARAM)).toBe(
      `${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`
    );
  });
});
