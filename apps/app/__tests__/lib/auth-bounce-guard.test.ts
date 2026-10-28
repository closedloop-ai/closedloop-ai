// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  AUTH_BOUNCE_CEILING,
  AUTH_BOUNCE_COOKIE,
  AUTH_RETURN_PARAM,
  AuthBounceAction,
  type AuthBounceRequest,
  buildAuthBounceBreakUrl,
  buildStaleSessionCookieDeletions,
  isAuthBounceCandidate,
  resolveAuthBounce,
  serializeCookieDeletion,
} from "@/lib/auth-bounce-guard";

/**
 * ISS-11429 — the bound on the signed-out `/sign-up` ↔ protected-URL bounce.
 *
 * The production defect these cases pin is a cycle with no ceiling: the
 * authenticated layout redirects a caller with no `userId` to
 * `/sign-up?redirect_url=<protected URL>`, Clerk's embed navigates back to that
 * URL on the strength of a session the server refuses, and nothing counts the
 * trips. One prod session logged 316 `/sign-up` views.
 *
 * Each case below fails against the pre-ISS-11429 tree, where
 * `resolveAuthBounce` did not exist and every request in the list took the same
 * un-counted path.
 */

const PROTECTED_URL =
  "https://app.closedloop.ai/closedloop-ai/issues/ISS-10754";
const STALE_SESSION_COOKIE = "__session_prod";

function bounceRequest(
  overrides: Partial<AuthBounceRequest> = {}
): AuthBounceRequest {
  return {
    bounceCookieValue: undefined,
    cookies: [
      { name: STALE_SESSION_COOKIE, value: "jwt" },
      // Non-zero: Clerk's own "this browser claims a session" marker.
      { name: "__client_uat_prod", value: "1700000000" },
      { name: "sidebar:state", value: "true" },
    ],
    isSignedIn: false,
    pathname: "/sign-up",
    searchParams: new URLSearchParams({ [AUTH_RETURN_PARAM]: PROTECTED_URL }),
    ...overrides,
  };
}

describe("resolveAuthBounce — the bounce is bounded", () => {
  it("counts the first bounce instead of letting it run unbounded", () => {
    expect(resolveAuthBounce(bounceRequest())).toEqual({
      action: AuthBounceAction.Count,
      count: 1,
    });
  });

  it("counts up to the ceiling, then breaks on the one past it", () => {
    for (let recorded = 1; recorded < AUTH_BOUNCE_CEILING; recorded += 1) {
      expect(
        resolveAuthBounce(
          bounceRequest({ bounceCookieValue: String(recorded) })
        )
      ).toEqual({ action: AuthBounceAction.Count, count: recorded + 1 });
    }

    const decision = resolveAuthBounce(
      bounceRequest({ bounceCookieValue: String(AUTH_BOUNCE_CEILING) })
    );
    expect(decision?.action).toBe(AuthBounceAction.Break);
  });

  it("names the refused session cookies to clear, and only those", () => {
    const decision = resolveAuthBounce(
      bounceRequest({ bounceCookieValue: String(AUTH_BOUNCE_CEILING) })
    );

    // The break is terminal ONLY because the client's belief in the session is
    // removed; asserting the redirect alone would leave the loop driver intact.
    expect(decision).toEqual({
      action: AuthBounceAction.Break,
      staleSessionCookieNames: [STALE_SESSION_COOKIE, "__client_uat_prod"],
    });
  });

  it("matches suffixed Clerk cookie names, which is the only shape prod has", () => {
    const decision = resolveAuthBounce(
      bounceRequest({
        bounceCookieValue: String(AUTH_BOUNCE_CEILING),
        cookies: [
          { name: "__client_uat_xyz", value: "1700000000" },
          { name: "__clerk_db_jwt_xyz", value: "jwt" },
          { name: "__refresh_xyz", value: "r" },
          { name: "unrelated", value: "x" },
        ],
      })
    );

    expect(decision).toEqual({
      action: AuthBounceAction.Break,
      staleSessionCookieNames: [
        "__client_uat_xyz",
        "__clerk_db_jwt_xyz",
        "__refresh_xyz",
      ],
    });
  });
});

describe("resolveAuthBounce — inert outside the pathological state", () => {
  it.each([
    [
      "a signed-in caller",
      bounceRequest({
        bounceCookieValue: String(AUTH_BOUNCE_CEILING),
        isSignedIn: true,
      }),
    ],
    [
      "a browser presenting no Clerk session to be refused",
      bounceRequest({
        bounceCookieValue: String(AUTH_BOUNCE_CEILING),
        cookies: [{ name: "sidebar:state", value: "true" }],
      }),
    ],
    [
      "an ordinary signed-out browser carrying Clerk's own signed-out marker",
      bounceRequest({
        bounceCookieValue: String(AUTH_BOUNCE_CEILING),
        cookies: [{ name: "__client_uat_prod", value: "0" }],
      }),
    ],
    [
      "a development browser carrying only an empty-valued Clerk cookie",
      bounceRequest({
        bounceCookieValue: String(AUTH_BOUNCE_CEILING),
        cookies: [
          { name: "__client_uat", value: "0" },
          { name: "__clerk_db_jwt", value: "dev" },
        ],
      }),
    ],
    [
      "an auth entry with no return URL",
      bounceRequest({
        bounceCookieValue: String(AUTH_BOUNCE_CEILING),
        searchParams: new URLSearchParams(),
      }),
    ],
    [
      "a route that is not an auth entry",
      bounceRequest({
        bounceCookieValue: String(AUTH_BOUNCE_CEILING),
        pathname: "/closedloop-ai/issues/ISS-10754",
      }),
    ],
  ])("returns null for %s", (_name, request) => {
    expect(resolveAuthBounce(request)).toBeNull();
  });

  it.each([
    "/sign-up",
    "/sign-up/verify-email-address",
    "/sign-up/tasks",
    "/sign-up/tasks/choose-organization",
  ])(
    "stays inert on %s during a real multi-step sign-up, past the ceiling",
    (pathname) => {
      // THE hazard this module is designed around: the guard must not be able to
      // fire part-way through somebody's sign-up and delete the credentials they
      // are mid-way through establishing. That is worse than the loop.
      //
      // Pinned with the cookies such a browser ACTUALLY presents — clerk-js
      // writes `__client_uat=0` for every signed-out browser that has loaded it,
      // and a development instance writes `__clerk_db_jwt` from the first page
      // load — so a guard gating on cookie NAMES alone fails here. Gating on
      // presence was the shipped defect; this case is what holds the fix.
      expect(
        resolveAuthBounce(
          bounceRequest({
            bounceCookieValue: String(AUTH_BOUNCE_CEILING),
            cookies: [
              { name: "__client_uat", value: "0" },
              { name: "__clerk_db_jwt", value: "dev" },
            ],
            pathname,
          })
        )
      ).toBeNull();
    }
  );
});

describe("resolveAuthBounce — a browser-supplied counter is not a measurement", () => {
  it.each([
    ["a negative", "-5"],
    ["a fraction", "1.5"],
    ["a magnitude past the safe-integer range", "1e21"],
    ["a blank string Number() would read as 0", ""],
    ["a non-numeric value", "lots"],
    ["whitespace", " "],
  ])(
    "reads %s as no bounce recorded rather than coercing it",
    (_name, value) => {
      expect(
        resolveAuthBounce(bounceRequest({ bounceCookieValue: value }))
      ).toEqual({ action: AuthBounceAction.Count, count: 1 });
    }
  );

  it("clamps a forged count above the ceiling to the ceiling", () => {
    // Still breaks (ceiling + 1 > ceiling), but via a clamped count rather than
    // by carrying an arbitrary magnitude forward.
    const decision = resolveAuthBounce(
      bounceRequest({ bounceCookieValue: "9007199254740991" })
    );
    expect(decision?.action).toBe(AuthBounceAction.Break);
  });
});

describe("isAuthBounceCandidate", () => {
  it.each([
    ["/sign-up", true],
    ["/sign-in", true],
    ["/sign-up/sso-callback", true],
    ["/sign-in/factor-one", true],
    ["/sign-upgrade", false],
    ["/closedloop-ai/issues/ISS-1", false],
  ])("classifies %s as %s", (pathname, expected) => {
    expect(
      isAuthBounceCandidate(
        pathname,
        new URLSearchParams({ [AUTH_RETURN_PARAM]: PROTECTED_URL })
      )
    ).toBe(expected);
  });

  it("is false without a return URL, so a plain visit costs no auth() call", () => {
    expect(isAuthBounceCandidate("/sign-up", new URLSearchParams())).toBe(
      false
    );
  });
});

describe("buildAuthBounceBreakUrl", () => {
  it("strips the return URL and keeps everything else", () => {
    const target = buildAuthBounceBreakUrl(
      new URL(
        `https://app.closedloop.ai/sign-up?${AUTH_RETURN_PARAM}=${encodeURIComponent(PROTECTED_URL)}&__clerk_ticket=abc`
      )
    );

    expect(target.searchParams.has(AUTH_RETURN_PARAM)).toBe(false);
    expect(target.searchParams.get("__clerk_ticket")).toBe("abc");
    expect(target.pathname).toBe("/sign-up");
  });

  it("does not mutate the URL it was handed", () => {
    const original = new URL(
      `https://app.closedloop.ai/sign-up?${AUTH_RETURN_PARAM}=${encodeURIComponent(PROTECTED_URL)}`
    );
    buildAuthBounceBreakUrl(original);
    expect(original.searchParams.get(AUTH_RETURN_PARAM)).toBe(PROTECTED_URL);
  });
});

describe("the cookie contract", () => {
  it("names the counter cookie once, for the proxy to read and write", () => {
    expect(AUTH_BOUNCE_COOKIE).toBe("cl_auth_bounce");
  });
});

describe("buildStaleSessionCookieDeletions", () => {
  it("emits a host-only AND an eTLD+1 deletion, both rooted at /", () => {
    // `ResponseCookies.delete(name)` sends only the host-only, default-path
    // form, and that removes NOTHING in production: Clerk sets `__session` and
    // `__client_uat` with `Domain=.closedloop.ai`, and a host-only expiry beside
    // a Domain-scoped cookie just adds a second empty one the browser keeps
    // sending alongside the original. The default PATH is the other half — a
    // break served on `/sign-up/sso-callback` defaults to that path and never
    // matches a cookie stored at `/`.
    expect(
      buildStaleSessionCookieDeletions(["__session"], "app.closedloop.ai")
    ).toEqual([
      { name: "__session", path: "/" },
      { domain: ".closedloop.ai", name: "__session", path: "/" },
    ]);
  });

  it("emits host-only alone when the host has no registrable parent", () => {
    expect(
      buildStaleSessionCookieDeletions(["__session"], "localhost:3000")
    ).toEqual([{ name: "__session", path: "/" }]);
  });

  it("covers every refused name", () => {
    const deletions = buildStaleSessionCookieDeletions(
      ["__session", "__client_uat"],
      "app.closedloop.ai"
    );
    expect(deletions.map(({ name }) => name).sort()).toEqual([
      "__client_uat",
      "__client_uat",
      "__session",
      "__session",
    ]);
    expect(deletions.every(({ path }) => path === "/")).toBe(true);
  });
});

describe("serializeCookieDeletion", () => {
  it("expires by both Max-Age and Expires, at the stated scope", () => {
    expect(
      serializeCookieDeletion({
        domain: ".closedloop.ai",
        name: "__session",
        path: "/",
      })
    ).toBe(
      "__session=; Path=/; Domain=.closedloop.ai; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0"
    );
  });

  it("omits Domain entirely for a host-only deletion", () => {
    const serialized = serializeCookieDeletion({
      name: "__session",
      path: "/",
    });
    expect(serialized).not.toContain("Domain");
    expect(serialized).toContain("Max-Age=0");
  });

  it("asserts neither Secure nor HttpOnly, which would narrow the match", () => {
    // Neither participates in the (name, domain, path) match that decides which
    // stored cookie a deletion removes, and `Secure` would make it fail over
    // plain HTTP.
    const serialized = serializeCookieDeletion({
      name: "__session",
      path: "/",
    });
    expect(serialized).not.toContain("Secure");
    expect(serialized).not.toContain("HttpOnly");
  });
});
