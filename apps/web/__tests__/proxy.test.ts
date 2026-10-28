import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `proxy.ts` is a Clerk-wrapped middleware, so nothing about it is reachable
 * without standing in for its four collaborators. Each stub is deliberately
 * inert: `authMiddleware` hands the inner handler straight back (and records
 * the options object, which is where the CSP branch lands), the security
 * middleware returns a fixed header set, and Nemo returns whatever a test
 * queues. What is left running is exactly the redirect and header-merge logic
 * this file owns.
 */
const mocks = vi.hoisted(() => ({
  env: {} as { CSP_ENABLED?: string; CSP_REPORT_URI?: string },
  authOptions: [] as unknown[],
  composedResult: undefined as Response | undefined,
  securityHeaders: {} as Record<string, string>,
}));

vi.mock("@/env", () => ({ env: mocks.env }));

vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (handler: unknown, options: unknown) => {
    mocks.authOptions.push(options);
    return handler;
  },
}));

vi.mock("@repo/security/proxy", () => ({
  noseconeOptions: {},
  securityMiddleware: () => () =>
    Promise.resolve(new Response(null, { headers: mocks.securityHeaders })),
}));

vi.mock("@repo/internationalization/proxy", () => ({
  internationalizationMiddleware: () => undefined,
}));

vi.mock("@rescale/nemo", () => ({
  createNEMO: () => () => Promise.resolve(mocks.composedResult),
}));

type Middleware = (
  auth: unknown,
  request: NextRequest,
  event: unknown
) => Promise<Response>;

const REDIRECT_HOST = "www.gethealthy.com";
const PRODUCT_HOST = "closedloop.ai";

beforeEach(() => {
  mocks.env.CSP_ENABLED = undefined;
  mocks.env.CSP_REPORT_URI = undefined;
  mocks.authOptions.length = 0;
  mocks.composedResult = undefined;
  mocks.securityHeaders = { "x-frame-options": "DENY" };
});

afterEach(() => {
  vi.resetModules();
});

describe("legacy closedloop.ai redirects", () => {
  test("302s a retired page to gethealthy.com, preserving the path", async () => {
    const middleware = await loadMiddleware();

    const response = await run(middleware, "https://closedloop.ai/blog", {
      host: PRODUCT_HOST,
    });

    expect(response.status).toBe(302);
    expect(new URL(headerOrThrow(response, "location")).host).toBe(
      REDIRECT_HOST
    );
    expect(new URL(headerOrThrow(response, "location")).pathname).toBe("/blog");
  });

  test("redirects the www host as well as the bare one", async () => {
    const middleware = await loadMiddleware();

    // `host === "www.closedloop.ai" || host === "closedloop.ai"` — the sibling
    // test above enters through the right-hand operand, this one the left.
    const response = await run(
      middleware,
      "https://www.closedloop.ai/careers",
      {
        host: "www.closedloop.ai",
      }
    );

    expect(response.status).toBe(302);
  });

  test("redirects a path under a retired prefix, not only exact pages", async () => {
    const middleware = await loadMiddleware();

    const response = await run(
      middleware,
      "https://closedloop.ai/press-release/series-b",
      { host: PRODUCT_HOST }
    );

    expect(response.status).toBe(302);
    expect(new URL(headerOrThrow(response, "location")).pathname).toBe(
      "/press-release/series-b"
    );
  });

  test("ignores a trailing slash when matching a retired page", async () => {
    const middleware = await loadMiddleware();

    const response = await run(middleware, "https://closedloop.ai/careers///", {
      host: PRODUCT_HOST,
    });

    expect(response.status).toBe(302);
  });

  test("serves the site root rather than redirecting it", async () => {
    const middleware = await loadMiddleware();

    // "/" strips to "" and falls back to "/", which is not a retired page.
    // Without that `|| "/"` the empty string matches nothing either — but a
    // fallback that produced a retired page instead would send the home page
    // off-site, which is the failure this pins.
    const response = await run(middleware, "https://closedloop.ai/", {
      host: PRODUCT_HOST,
    });

    expect(response.status).not.toBe(302);
  });

  test("serves a live page on the legacy host", async () => {
    const middleware = await loadMiddleware();

    const response = await run(middleware, "https://closedloop.ai/pricing", {
      host: PRODUCT_HOST,
    });

    expect(response.status).not.toBe(302);
  });

  test("never redirects a request on another host", async () => {
    const middleware = await loadMiddleware();

    // Same retired path, different host: the redirect table is scoped to the
    // legacy marketing hosts, so the preview/vercel host must pass through.
    const response = await run(middleware, "https://preview.vercel.app/blog", {
      host: "preview.vercel.app",
    });

    expect(response.status).not.toBe(302);
  });

  test("never redirects a request that sends no host header", async () => {
    const middleware = await loadMiddleware();

    const response = await run(middleware, "https://closedloop.ai/blog");

    // `?? ""` — an absent Host matches neither legacy host. A fallback that
    // guessed the URL's host instead would redirect this.
    expect(response.status).not.toBe(302);
  });

  test("compares the host without its port", async () => {
    const middleware = await loadMiddleware();

    const response = await run(middleware, "https://closedloop.ai/blog", {
      host: "closedloop.ai:3000",
    });

    expect(response.status).toBe(302);
  });
});

describe("security header merging", () => {
  test("copies security headers onto a response the i18n middleware returned", async () => {
    mocks.securityHeaders = {
      "x-frame-options": "DENY",
      "x-middleware-next": "1",
    };
    mocks.composedResult = new Response(null, {
      headers: { "x-locale-rewrite": "de" },
    });
    const middleware = await loadMiddleware();

    const response = await run(middleware, "https://example.test/de", {
      host: "example.test",
    });

    expect(response.headers.get("x-locale-rewrite")).toBe("de");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    // `x-middleware-*` headers are Next's own routing instructions; copying
    // them onto the i18n response would replay a stale routing decision.
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  test("returns the security response itself when i18n returns nothing", async () => {
    mocks.composedResult = undefined;
    const middleware = await loadMiddleware();

    const response = await run(middleware, "https://example.test/en", {
      host: "example.test",
    });

    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("content security policy", () => {
  test("configures a report-only strict CSP when enabled", async () => {
    mocks.env.CSP_ENABLED = "true";
    mocks.env.CSP_REPORT_URI = "https://csp.example.test/report";
    await loadMiddleware();

    const options = mocks.authOptions.at(0) as {
      contentSecurityPolicy?: {
        strict: boolean;
        reportOnly: boolean;
        reportTo: string;
        directives: Record<string, string[]>;
      };
    };

    expect(options.contentSecurityPolicy?.strict).toBe(true);
    expect(options.contentSecurityPolicy?.reportOnly).toBe(true);
    expect(options.contentSecurityPolicy?.reportTo).toBe(
      "https://csp.example.test/report"
    );
    expect(options.contentSecurityPolicy?.directives["base-uri"]).toEqual([
      "none",
    ]);
    // GA4 beacons to google.com/g/collect; without it every page load files a
    // false-positive violation.
    expect(options.contentSecurityPolicy?.directives["connect-src"]).toContain(
      "https://www.google.com"
    );
  });

  test("sends no CSP at all when the flag is anything but the string 'true'", async () => {
    mocks.env.CSP_ENABLED = "1";
    await loadMiddleware();

    const options = mocks.authOptions.at(0) as {
      contentSecurityPolicy?: unknown;
    };

    // Undefined, not an empty policy object: a `{}` here would hand Clerk a
    // policy with no directives rather than leaving CSP off.
    expect(options.contentSecurityPolicy).toBeUndefined();
  });
});

async function loadMiddleware(): Promise<Middleware> {
  const { default: middleware } = await import("@/proxy");

  return middleware as unknown as Middleware;
}

function run(
  middleware: Middleware,
  url: string,
  headers?: Record<string, string>
): Promise<Response> {
  return middleware({}, new NextRequest(url, { headers }), {});
}

function headerOrThrow(response: Response, name: string): string {
  const value = response.headers.get(name);

  if (value === null) {
    throw new Error(`response carried no ${name} header`);
  }

  return value;
}
