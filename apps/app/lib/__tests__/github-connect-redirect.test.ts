import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  DesktopSignInProvider,
} from "@repo/api/src/types/desktop-authorize-url";
import { describe, expect, it } from "vitest";
import {
  buildGitHubConnectRedirectUrl,
  GITHUB_CONNECT_DEFAULT_TARGET,
  GITHUB_CONNECT_REDIRECT_PARAM,
  resolveDesktopSignInProviderFromSearchParams,
  resolveGitHubConnectRedirectFromSearchParams,
  resolveGitHubConnectRedirectTarget,
  shouldDeepLinkGitHubConnect,
} from "../github-connect-redirect";

const APP_ORIGIN = "https://app.closedloop.ai";

/**
 * A representative desktop authorize URL: PKCE challenge, opaque state, the
 * loopback redirect_uri, and the base64url gateway key. The whole query string
 * has to survive the deep-link hop or the desktop's loopback listener hangs
 * until it times out.
 */
const DESKTOP_AUTHORIZE_SEARCH =
  "?code_challenge=abc123&code_challenge_method=S256&state=xyz789" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A51789%2Fcallback" +
  "&gateway_id=gw-1&gateway_public_key=LS0tLS1CRUdJTg&device_name=Kris%20MacBook&platform=darwin";

describe("shouldDeepLinkGitHubConnect", () => {
  it("intercepts the bare desktop authorize path", () => {
    expect(
      shouldDeepLinkGitHubConnect("/settings/integrations/desktop/authorize")
    ).toBe(true);
  });

  it("leaves every other signed-out route on the normal sign-in embed", () => {
    expect(shouldDeepLinkGitHubConnect("/sign-in")).toBe(false);
    expect(shouldDeepLinkGitHubConnect("/settings")).toBe(false);
    expect(
      shouldDeepLinkGitHubConnect("/settings/integrations/desktop/connect")
    ).toBe(false);
  });

  it("does not intercept the org-scoped form, which only exists post-auth", () => {
    expect(
      shouldDeepLinkGitHubConnect(
        "/acme/settings/integrations/desktop/authorize"
      )
    ).toBe(false);
  });
});

describe("buildGitHubConnectRedirectUrl", () => {
  it("preserves the full authorize query string as the post-auth target", () => {
    const requestUrl = new URL(
      `${APP_ORIGIN}/settings/integrations/desktop/authorize${DESKTOP_AUTHORIZE_SEARCH}`
    );

    const deepLink = buildGitHubConnectRedirectUrl(requestUrl);

    expect(deepLink.pathname).toBe("/connect/github");
    expect(deepLink.searchParams.get(GITHUB_CONNECT_REDIRECT_PARAM)).toBe(
      `/settings/integrations/desktop/authorize${DESKTOP_AUTHORIZE_SEARCH}`
    );
  });

  it("redirects within the requesting origin so preview deploys stay put", () => {
    const preview = "https://app-stage-git-branch-closed-loop.vercel.app";
    const requestUrl = new URL(
      `${preview}/settings/integrations/desktop/authorize?state=xyz`
    );

    expect(buildGitHubConnectRedirectUrl(requestUrl).origin).toBe(preview);
  });

  // ISS-5112: the desktop's provider answer has to survive the hop, or picking
  // Google in the desktop lands on GitHub's consent screen.
  it("carries a recognized provider through to the deep link", () => {
    const requestUrl = new URL(
      `${APP_ORIGIN}/settings/integrations/desktop/authorize?state=xyz&provider=google`
    );

    expect(
      buildGitHubConnectRedirectUrl(requestUrl).searchParams.get(
        DESKTOP_AUTHORIZE_QUERY_PARAMS.provider
      )
    ).toBe(DesktopSignInProvider.Google);
  });

  // Omission is preserved rather than serialized as an empty/null value: an
  // older desktop build sends no provider, and the deep link it produces must
  // stay byte-identical to the one this route has always issued.
  it("omits the provider param entirely when the request names none", () => {
    const requestUrl = new URL(
      `${APP_ORIGIN}/settings/integrations/desktop/authorize${DESKTOP_AUTHORIZE_SEARCH}`
    );

    expect(
      buildGitHubConnectRedirectUrl(requestUrl).searchParams.has(
        DESKTOP_AUTHORIZE_QUERY_PARAMS.provider
      )
    ).toBe(false);
  });

  it("drops an unrecognized provider rather than forwarding it", () => {
    const requestUrl = new URL(
      `${APP_ORIGIN}/settings/integrations/desktop/authorize?state=xyz&provider=gitlab`
    );

    expect(
      buildGitHubConnectRedirectUrl(requestUrl).searchParams.has(
        DESKTOP_AUTHORIZE_QUERY_PARAMS.provider
      )
    ).toBe(false);
  });
});

describe("resolveDesktopSignInProviderFromSearchParams", () => {
  it("selects the provider the desktop named", () => {
    expect(
      resolveDesktopSignInProviderFromSearchParams({ provider: "google" })
    ).toBe(DesktopSignInProvider.Google);
    expect(
      resolveDesktopSignInProviderFromSearchParams({ provider: "github" })
    ).toBe(DesktopSignInProvider.GitHub);
  });

  // Absent and unrecognized both mean "the flow this route has always started":
  // a version-skewed desktop build sends nothing, and an unknown value must not
  // strand the user on a strategy Clerk has no connection for.
  it("falls back to GitHub for an absent or unknown value", () => {
    expect(resolveDesktopSignInProviderFromSearchParams({})).toBe(
      DesktopSignInProvider.GitHub
    );
    expect(
      resolveDesktopSignInProviderFromSearchParams({ provider: "gitlab" })
    ).toBe(DesktopSignInProvider.GitHub);
    expect(resolveDesktopSignInProviderFromSearchParams({ provider: "" })).toBe(
      DesktopSignInProvider.GitHub
    );
  });

  // Matches the redirect_url resolver: an appended second copy must not be able
  // to displace the value the desktop actually sent.
  it("takes the first value of a repeated key", () => {
    expect(
      resolveDesktopSignInProviderFromSearchParams({
        provider: ["google", "github"],
      })
    ).toBe(DesktopSignInProvider.Google);
  });
});

describe("resolveGitHubConnectRedirectTarget — open-redirect boundary", () => {
  it("accepts a rooted same-origin path with its query", () => {
    expect(
      resolveGitHubConnectRedirectTarget(
        "/settings/integrations/desktop/authorize?state=xyz",
        APP_ORIGIN
      )
    ).toBe("/settings/integrations/desktop/authorize?state=xyz");
  });

  it("reduces an absolute same-origin URL to its path", () => {
    expect(
      resolveGitHubConnectRedirectTarget(
        `${APP_ORIGIN}/settings/integrations/desktop/authorize?state=xyz`,
        APP_ORIGIN
      )
    ).toBe("/settings/integrations/desktop/authorize?state=xyz");
  });

  it("rejects an off-origin absolute URL", () => {
    expect(
      resolveGitHubConnectRedirectTarget(
        "https://evil.test/steal?state=xyz",
        APP_ORIGIN
      )
    ).toBeNull();
  });

  it("rejects a protocol-relative URL that mimics a rooted path", () => {
    expect(
      resolveGitHubConnectRedirectTarget("//evil.test/steal", APP_ORIGIN)
    ).toBeNull();
  });

  // The bypass a prefix check cannot see. The WHATWG URL parser treats `\` as a
  // path separator for special schemes, so these look same-origin as strings
  // but resolve off-origin as URLs. Percent-encoded (`%5C`) they survive Next's
  // searchParams decoding and arrive here as literal backslashes.
  it.each([
    String.raw`/\evil.test/steal`,
    String.raw`/\\evil.test`,
    String.raw`\\evil.test`,
    String.raw`/\/evil.test`,
  ])("rejects the backslash authority form %s", (candidate) => {
    expect(
      resolveGitHubConnectRedirectTarget(candidate, APP_ORIGIN)
    ).toBeNull();
  });

  it("rejects a javascript: scheme", () => {
    expect(
      resolveGitHubConnectRedirectTarget("javascript:alert(1)", APP_ORIGIN)
    ).toBeNull();
  });

  it("returns null for a missing or empty value", () => {
    expect(resolveGitHubConnectRedirectTarget(null, APP_ORIGIN)).toBeNull();
    expect(
      resolveGitHubConnectRedirectTarget(undefined, APP_ORIGIN)
    ).toBeNull();
    expect(resolveGitHubConnectRedirectTarget("", APP_ORIGIN)).toBeNull();
  });
});

describe("resolveGitHubConnectRedirectFromSearchParams", () => {
  it("resolves a valid target off the search-param bag", () => {
    expect(
      resolveGitHubConnectRedirectFromSearchParams(
        {
          [GITHUB_CONNECT_REDIRECT_PARAM]: `/settings/integrations/desktop/authorize${DESKTOP_AUTHORIZE_SEARCH}`,
        },
        APP_ORIGIN
      )
    ).toBe(
      `/settings/integrations/desktop/authorize${DESKTOP_AUTHORIZE_SEARCH}`
    );
  });

  // A repeated `?redirect_url=` arrives as an array. Taking the FIRST value
  // means an attacker who can append a second one cannot displace the real
  // target — and whichever value wins is still origin-checked.
  it("takes the first value of a repeated key", () => {
    expect(
      resolveGitHubConnectRedirectFromSearchParams(
        {
          [GITHUB_CONNECT_REDIRECT_PARAM]: ["/settings", "https://evil.test"],
        },
        APP_ORIGIN
      )
    ).toBe("/settings");
  });

  it("falls back to the default target when absent or untrusted", () => {
    expect(resolveGitHubConnectRedirectFromSearchParams({}, APP_ORIGIN)).toBe(
      GITHUB_CONNECT_DEFAULT_TARGET
    );
    expect(
      resolveGitHubConnectRedirectFromSearchParams(
        { [GITHUB_CONNECT_REDIRECT_PARAM]: String.raw`/\evil.test` },
        APP_ORIGIN
      )
    ).toBe(GITHUB_CONNECT_DEFAULT_TARGET);
  });
});
