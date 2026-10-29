import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// Clerk's own `img-src` defaults, restated by `apps/app` so the effective
// directive is the same whether Clerk merges into them or replaces them.
// Unquoted `self` is the spelling Clerk's DEFAULT_DIRECTIVES use; its
// `formatValue` adds the quotes on the way into the header.
const SELF = "self";
const CLERK_IMG = "https://img.clerk.com";
const IMG_EXTRA = "https://img-extra.example";
const CONNECT_EXTRA = "https://connect-extra.example";
const REPORT_URI =
  "https://csp-report.browser-intake-datadoghq.com/api/v2/logs";
const API_URL = "http://api.test";

type AuthMiddlewareOptions = {
  contentSecurityPolicy?: {
    strict?: boolean;
    reportOnly?: boolean;
    reportTo?: string;
    directives?: Record<string, string[]>;
  };
};

// Only the half of `NextRequest` the policy callback consumes.
type CspRequest = { headers: Headers };
type AuthMiddlewareOptionsCallback = (
  request: CspRequest
) => AuthMiddlewareOptions;

const captured = vi.hoisted(() => ({
  resolveOptions: undefined as AuthMiddlewareOptionsCallback | undefined,
}));

// Capture the OPTIONS CALLBACK handed to Clerk's middleware wrapper and
// resolve it the way Clerk does (`typeof params === "function" ? await
// params(req) : params`) — the resolved object is the production CSP wiring
// under test. The directives below are build-time, so any host resolves them.
vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (
    callback: (auth: ClerkMiddlewareAuth, request: NextRequest) => unknown,
    options: AuthMiddlewareOptionsCallback
  ) => {
    captured.resolveOptions = options;
    return callback;
  },
}));

vi.mock("@repo/analytics/proxy", () => ({
  analyticsMiddleware: () => () => Promise.resolve(new Response()),
}));

// Force the CSP-enabled branch — the sibling proxy suites keep it disabled, so
// without this the directive wiring would never be exercised by any test. The
// real buildConnectSrc is kept so the assertions exercise the production
// assembler, not a stand-in.
vi.mock("@/lib/content-security-policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/content-security-policy")>();
  return {
    ...actual,
    shouldEnableContentSecurityPolicy: () => true,
  };
});

vi.mock("@/lib/engineer/electron-probe", () => ({
  getPossibleElectronHostnames: () => [],
}));

vi.mock("@/env", () => ({
  env: {
    CSP_ENABLED: "true",
    VERCEL_ENV: "production",
    NEXT_PUBLIC_API_URL: "http://api.test",
    NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined,
    CSP_REPORT_URI:
      "https://csp-report.browser-intake-datadoghq.com/api/v2/logs",
    CSP_EXTRA_IMG_SRC: ["https://img-extra.example"],
    CSP_EXTRA_CONNECT_SRC: ["https://connect-extra.example"],
  },
}));

// Imported after the mocks are registered.
import "@/proxy";

describe("proxy CSP directive wiring (ISS-7475)", () => {
  it("lands each CSP_EXTRA_* env list in its own directive, alongside the static allowlist", () => {
    const csp = captured.resolveOptions?.({
      headers: new Headers({ host: "app.test" }),
    })?.contentSecurityPolicy;
    expect(csp).toBeDefined();
    expect(csp?.strict).toBe(true);
    expect(csp?.reportOnly).toBe(true);
    expect(csp?.reportTo).toBe(REPORT_URI);

    const imgSrc = csp?.directives?.["img-src"] ?? [];
    const connectSrc = csp?.directives?.["connect-src"] ?? [];

    expect(imgSrc).toEqual(
      expect.arrayContaining([
        "data:",
        "https://avatars.githubusercontent.com",
        "https://img.shields.io",
        IMG_EXTRA,
      ])
    );
    expect(connectSrc).toEqual(
      expect.arrayContaining([
        API_URL,
        "https://cdn.jsdelivr.net",
        CONNECT_EXTRA,
      ])
    );

    // Swapped-array regression: each extra must be absent from the OTHER
    // directive, so wiring both vars into one array cannot stay green.
    expect(imgSrc).not.toContain(CONNECT_EXTRA);
    expect(connectSrc).not.toContain(IMG_EXTRA);
  });

  // Clerk reaches `handleExistingDirective` only while `img-src` is in its
  // DEFAULT_DIRECTIVES; drop out of that set and the same array REPLACES the
  // defaults instead of merging with them. `packages/auth` asks for `^7.2.3`
  // and `7.2.5` resolves, so a lockfile refresh can move that branch under us
  // with no code change in `proxy.ts`. This policy ENFORCES on prod
  // (ISS-8437), so that would BLOCK every same-origin image and every Clerk
  // avatar rather than emit a report line. Restating the two values removes
  // the dependency, and this pins the restatement so a future "these are
  // redundant, Clerk supplies them" cleanup reddens here instead.
  //
  // The case above deliberately does NOT cover this: it matches `img-src`
  // with `arrayContaining`, which stays green with both values deleted.
  //
  // SCOPE: this pins the array `apps/app` hands Clerk, which is the half this
  // repo owns. It does not reach `handleExistingDirective`/`handleCustomDirective`
  // and so proves nothing about which branch Clerk takes — that is Clerk's
  // code under its own version, and only the restatement above makes the two
  // branches agree.
  it("states Clerk's img-src defaults in the directive array apps/app hands Clerk", () => {
    const imgSrc =
      captured.resolveOptions?.({
        headers: new Headers({ host: "app.test" }),
      })?.contentSecurityPolicy?.directives?.["img-src"] ?? [];

    expect(imgSrc).toContain(SELF);
    expect(imgSrc).toContain(CLERK_IMG);
  });
});
