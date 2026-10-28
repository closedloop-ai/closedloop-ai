/**
 * ISS-12054: `authMiddleware` decides `AUTH_MODE=local_trusted` BEFORE Clerk.
 *
 * Clerk's middleware is replaced with a recorder, so each case can say whether
 * Clerk was built and whether it saw the request. The handler is a stand-in
 * for `apps/api/proxy.ts`: it stamps a header the way that proxy stamps CORS,
 * so "the handler ran" is observable on the response.
 */
import { type NextFetchEvent, NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthMode,
  E2E_LOCAL_TRUSTED_AUTH_ENABLED,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_USER_ID,
} from "../auth-mode";
import {
  E2E_LOCAL_TRUSTED_ALLOWED_HOSTS_ENV,
  LocalTrustedRefusal,
} from "../local-trusted-request-guard";
import { LOCAL_TRUSTED_REFUSAL_HEADER } from "../proxy";

const clerk = vi.hoisted(() => ({ built: 0, requests: 0 }));

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: () => {
    clerk.built += 1;
    return () => {
      clerk.requests += 1;
      return NextResponse.next({ headers: { "x-clerk-handled": "1" } });
    };
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => url,
}));

const HANDLED_HEADER = "x-handler-saw";
const ENFORCING_HEADER = "content-security-policy";
const NONCE_HEADER = "x-nonce";
const REQUEST_OVERRIDE_PREFIX = "x-middleware-request-";
const REFUSED_PATTERN = /refused/;
const FORBIDDEN = 403;
const NO_EVENT = { waitUntil: () => undefined } as unknown as NextFetchEvent;

const ENV_KEYS = [
  "AUTH_MODE",
  E2E_LOCAL_TRUSTED_ALLOWED_HOSTS_ENV,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  "NODE_ENV",
  "VERCEL_ENV",
] as const;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  clerk.built = 0;
  clerk.requests = 0;
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
  Reflect.set(process.env, "NODE_ENV", "test");
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      Reflect.set(process.env, key, value);
    }
  }
  originalEnv.clear();
});

describe("authMiddleware under AUTH_MODE=local_trusted", () => {
  it("runs the handler on the synthetic session without building or entering Clerk", async () => {
    activateLocalTrusted();
    const middleware = await buildMiddleware();

    const response = await middleware(makeRequest(), NO_EVENT);

    expect(response?.headers.get(HANDLED_HEADER)).toBe(
      `${LOCAL_TRUSTED_USER_ID}@${LOCAL_TRUSTED_ORG_SLUG}`
    );
    expect(clerk.built).toBe(0);
    expect(clerk.requests).toBe(0);
  });

  it("applies the contentSecurityPolicy option and replays it onto the request", async () => {
    activateLocalTrusted();
    const middleware = await buildMiddleware({
      strict: true,
      reportOnly: false,
      directives: { "base-uri": ["none"], "connect-src": ["self"] },
    });

    const response = await middleware(makeRequest(), NO_EVENT);
    const policy = response?.headers.get(ENFORCING_HEADER) ?? "";
    const nonce = response?.headers.get(NONCE_HEADER);

    expect(nonce).toBeTruthy();
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("base-uri 'none'");
    expect(
      response?.headers.get(`${REQUEST_OVERRIDE_PREFIX}${ENFORCING_HEADER}`)
    ).toBe(policy);
    expect(clerk.requests).toBe(0);
  });

  it.each([
    ["a LAN address", "192.168.1.20:3200"],
    ["a rebound DNS name", "attacker.example:3200"],
  ])(
    "refuses a request addressed to %s before the handler runs",
    async (_label, host) => {
      activateLocalTrusted();
      const middleware = await buildMiddleware();

      const response = await middleware(
        makeRequest({ headers: { host } }),
        NO_EVENT
      );

      expect(response?.status).toBe(FORBIDDEN);
      expect(response?.headers.get(LOCAL_TRUSTED_REFUSAL_HEADER)).toBe(
        LocalTrustedRefusal.Host
      );
      expect(response?.headers.get(HANDLED_HEADER)).toBeNull();
    }
  );

  it("serves a host a harness names in E2E_LOCAL_TRUSTED_ALLOWED_HOSTS", async () => {
    activateLocalTrusted();
    Reflect.set(process.env, E2E_LOCAL_TRUSTED_ALLOWED_HOSTS_ENV, "api-local");
    const middleware = await buildMiddleware();

    const response = await middleware(
      makeRequest({ headers: { host: "api-local:3004" } }),
      NO_EVENT
    );

    expect(response?.headers.get(HANDLED_HEADER)).toBeTruthy();
  });

  it.each([
    ["a foreign site", "https://attacker.example"],
    ["an opaque origin", "null"],
  ])("refuses a simple cross-origin POST from %s", async (_label, origin) => {
    activateLocalTrusted();
    const middleware = await buildMiddleware();

    const response = await middleware(
      makeRequest({
        method: "POST",
        headers: { origin, "content-type": "text/plain" },
      }),
      NO_EVENT
    );

    expect(response?.status).toBe(FORBIDDEN);
    expect(response?.headers.get(LOCAL_TRUSTED_REFUSAL_HEADER)).toBe(
      LocalTrustedRefusal.Origin
    );
    expect(response?.headers.get(HANDLED_HEADER)).toBeNull();
  });

  it("serves a POST from the local web origin, and a foreign read", async () => {
    activateLocalTrusted();
    const middleware = await buildMiddleware();

    const post = await middleware(makeRequest({ method: "POST" }), NO_EVENT);
    const read = await middleware(
      makeRequest({ headers: { origin: "https://attacker.example" } }),
      NO_EVENT
    );

    expect(post?.headers.get(HANDLED_HEADER)).toBeTruthy();
    expect(read?.headers.get(HANDLED_HEADER)).toBeTruthy();
  });

  it("serves a cross-origin POST that carries Authorization, which a page cannot send unpreflighted", async () => {
    activateLocalTrusted();
    const middleware = await buildMiddleware();

    const response = await middleware(
      makeRequest({
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          authorization: "Bearer sk_live_example",
        },
      }),
      NO_EVENT
    );

    expect(response?.headers.get(HANDLED_HEADER)).toBeTruthy();
  });

  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["VERCEL_ENV=production", { VERCEL_ENV: "production" }],
    ["VERCEL_ENV=preview", { VERCEL_ENV: "preview" }],
    [
      `${E2E_LOCAL_TRUSTED_AUTH_ENV} unset`,
      { [E2E_LOCAL_TRUSTED_AUTH_ENV]: "" },
    ],
  ])(
    "refuses a deployed-like environment (%s) instead of granting the synthetic session",
    async (_label, overrides) => {
      activateLocalTrusted();
      for (const [key, value] of Object.entries(overrides)) {
        if (value === "") {
          Reflect.deleteProperty(process.env, key);
        } else {
          Reflect.set(process.env, key, value);
        }
      }
      const middleware = await buildMiddleware();

      expect(() => middleware(makeRequest(), NO_EVENT)).toThrow(
        REFUSED_PATTERN
      );
      expect(clerk.requests).toBe(0);
    }
  );

  it("leaves every request to Clerk when AUTH_MODE is not local_trusted", async () => {
    // The non-production signal alone grants nothing.
    Reflect.set(
      process.env,
      E2E_LOCAL_TRUSTED_AUTH_ENV,
      E2E_LOCAL_TRUSTED_AUTH_ENABLED
    );
    const middleware = await buildMiddleware();

    const first = await middleware(makeRequest(), NO_EVENT);
    await middleware(makeRequest(), NO_EVENT);

    expect(first?.headers.get("x-clerk-handled")).toBe("1");
    expect(first?.headers.get(HANDLED_HEADER)).toBeNull();
    expect(clerk.built).toBe(1);
    expect(clerk.requests).toBe(2);
  });

  it("uses Clerk when AUTH_MODE is clerk", async () => {
    Reflect.set(process.env, "AUTH_MODE", AuthMode.Clerk);
    Reflect.set(
      process.env,
      E2E_LOCAL_TRUSTED_AUTH_ENV,
      E2E_LOCAL_TRUSTED_AUTH_ENABLED
    );
    const middleware = await buildMiddleware();

    await middleware(makeRequest(), NO_EVENT);

    expect(clerk.requests).toBe(1);
  });
});

async function buildMiddleware(
  contentSecurityPolicy?: Record<string, unknown>
) {
  const { authMiddleware } = await import("../proxy");
  return authMiddleware(
    async (auth) => {
      const session = await auth();
      return NextResponse.next({
        headers: {
          [HANDLED_HEADER]: `${session.userId}@${session.orgSlug}`,
        },
      });
    },
    () => (contentSecurityPolicy ? { contentSecurityPolicy } : {})
  );
}

function activateLocalTrusted(): void {
  Reflect.set(process.env, "AUTH_MODE", AuthMode.LocalTrusted);
  Reflect.set(
    process.env,
    E2E_LOCAL_TRUSTED_AUTH_ENV,
    E2E_LOCAL_TRUSTED_AUTH_ENABLED
  );
}

function makeRequest(
  init: { method?: string; headers?: Record<string, string> } = {}
): NextRequest {
  return new NextRequest("http://localhost:3200/dashboard", {
    method: init.method ?? "GET",
    headers: {
      host: "localhost:3200",
      origin: "http://localhost:3200",
      ...init.headers,
    },
  });
}
