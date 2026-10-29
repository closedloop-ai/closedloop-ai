/**
 * ISS-12054: the API's CORS headers under `AUTH_MODE=local_trusted` with no
 * Clerk credentials.
 *
 * With no publishable key, Clerk's middleware answered every request itself in
 * development and never ran this proxy's handler, so a local stack's browser
 * reads failed preflight with no `Access-Control-Allow-Origin`. The real
 * `@repo/auth/proxy` runs here; only Clerk's own middleware is replaced, with
 * one that fails the case if it is entered.
 */
import {
  AuthMode,
  E2E_LOCAL_TRUSTED_AUTH_ENABLED,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
} from "@repo/auth/auth-mode";
import { type NextFetchEvent, NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ requests: 0 }));

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: () => () => {
    clerk.requests += 1;
    throw new Error("Clerk was entered on the local-trusted path");
  },
}));

import proxy from "@/proxy";

const LOCAL_WEB_ORIGIN = "http://localhost:3200";
const NO_EVENT = { waitUntil: () => undefined } as unknown as NextFetchEvent;
const NO_CONTENT = 204;
const REFUSED_PATTERN = /refused/;

const ENV_KEYS = [
  "AUTH_MODE",
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  "NODE_ENV",
  "VERCEL_ENV",
] as const;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  clerk.requests = 0;
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
  Reflect.set(process.env, "NODE_ENV", "development");
  Reflect.set(process.env, "AUTH_MODE", AuthMode.LocalTrusted);
  Reflect.set(
    process.env,
    E2E_LOCAL_TRUSTED_AUTH_ENV,
    E2E_LOCAL_TRUSTED_AUTH_ENABLED
  );
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

describe("apps/api proxy under AUTH_MODE=local_trusted", () => {
  it("answers a preflight from the local web origin with CORS headers", async () => {
    const response = await proxy(request("OPTIONS"), NO_EVENT);

    expect(response?.status).toBe(NO_CONTENT);
    expect(response?.headers.get("access-control-allow-origin")).toBe(
      LOCAL_WEB_ORIGIN
    );
    expect(clerk.requests).toBe(0);
  });

  it("stamps CORS headers on a read", async () => {
    const response = await proxy(request("GET"), NO_EVENT);

    expect(response?.headers.get("access-control-allow-origin")).toBe(
      LOCAL_WEB_ORIGIN
    );
    expect(response?.headers.get("access-control-allow-credentials")).toBe(
      "true"
    );
    expect(clerk.requests).toBe(0);
  });

  it("refuses the request in a production build instead of granting the synthetic session", () => {
    Reflect.set(process.env, "NODE_ENV", "production");

    expect(() => proxy(request("GET"), NO_EVENT)).toThrow(REFUSED_PATTERN);
    expect(clerk.requests).toBe(0);
  });
});

function request(method: string): NextRequest {
  return new NextRequest("http://localhost:3201/me", {
    method,
    headers: { host: "localhost:3201", origin: LOCAL_WEB_ORIGIN },
  });
}
