import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAppVisualHostEnv } from "@/__tests__/helpers/app-visual-host-env";
import {
  ROOT_LAYOUT_FAILURE_VALIDATION_HEADER,
  ROOT_LAYOUT_FAILURE_VALIDATION_HEADER_VALUE,
} from "@/lib/root-layout-failure-validation";

// ISS-10078: the two production call sites of the e2e root-layout-failure
// switch. The predicate's own locks are `lib/__tests__/root-layout-failure-
// validation.test.ts`; this pins that the layout and the proxy pass it both
// the server env gate and the request's header, so neither alone moves them.

type ContentSecurityPolicyOptions = { reportOnly?: boolean; strict?: boolean };
type CspRequest = { headers: Headers };
type AuthMiddlewareOptionsCallback = (request: CspRequest) => {
  contentSecurityPolicy?: ContentSecurityPolicyOptions;
};

const harness = vi.hoisted(() => ({
  requestHeaders: new Map<string, string>(),
  resolveOptions: undefined as AuthMiddlewareOptionsCallback | undefined,
  env: {
    CSP_ENABLED: undefined as string | undefined,
    ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED: undefined as string | undefined,
    VERCEL_ENV: undefined,
    NEXT_PUBLIC_API_URL: "http://localhost:3002",
    NEXT_PUBLIC_APP_URL: "http://localhost:3003",
    NEXT_PUBLIC_WEB_URL: "http://localhost:3001",
    NEXT_PUBLIC_DOCS_URL: "http://localhost:3001/docs",
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => harness.requestHeaders.get(name) ?? null,
  }),
}));
vi.mock("next/font/google", () => ({
  Silkscreen: () => ({ variable: "font-pixel" }),
}));
vi.mock("@repo/design-system/lib/fonts", () => ({ fonts: "test-font-class" }));
vi.mock("@/env", () => ({ env: harness.env }));
vi.mock("@/lib/deployment-pin", () => ({
  resolveApiDeploymentPin: async () => undefined,
}));
vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (
    callback: (auth: ClerkMiddlewareAuth, request: NextRequest) => unknown,
    options: AuthMiddlewareOptionsCallback
  ) => {
    harness.resolveOptions = options;
    return callback;
  },
}));
vi.mock("@repo/analytics/proxy", () => ({
  analyticsMiddleware: () => () => Promise.resolve(new Response()),
}));
vi.mock("@/lib/engineer/electron-probe", () => ({
  getPossibleElectronHostnames: () => [],
}));

beforeEach(() => {
  harness.requestHeaders.clear();
  harness.requestHeaders.set(
    ROOT_LAYOUT_FAILURE_VALIDATION_HEADER,
    ROOT_LAYOUT_FAILURE_VALIDATION_HEADER_VALUE
  );
  harness.env.CSP_ENABLED = undefined;
  harness.env.ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED = undefined;
  stubAppVisualHostEnv();
  vi.stubEnv("NEXT_PUBLIC_APP_ENVIRONMENT", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderRootLayout(): Promise<unknown> {
  vi.resetModules();
  const { default: RootLayout } = await import("../app/layout");
  return RootLayout({ children: null });
}

async function proxyPolicy(): Promise<
  ContentSecurityPolicyOptions | undefined
> {
  vi.resetModules();
  await import("@/proxy");
  return harness.resolveOptions?.({
    headers: new Headers([...harness.requestHeaders, ["host", "localhost"]]),
  })?.contentSecurityPolicy;
}

describe("app/layout.tsx root-layout failure switch (ISS-10078)", () => {
  it("throws for the asking request once the server gate is open", async () => {
    harness.env.ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED = "true";

    await expect(renderRootLayout()).rejects.toThrow("ISS-10078");
  });

  it("renders for the same request while the gate is closed", async () => {
    await expect(renderRootLayout()).resolves.toBeDefined();
  });

  it("renders for a request that does not ask while the gate is open", async () => {
    harness.env.ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED = "true";
    harness.requestHeaders.clear();

    await expect(renderRootLayout()).resolves.toBeDefined();
  });
});

describe("proxy.ts policy for the root-layout failure request (ISS-10078)", () => {
  it("serves the strict policy ENFORCING on a host that otherwise serves none", async () => {
    harness.env.ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED = "true";

    const policy = await proxyPolicy();

    expect(policy?.strict).toBe(true);
    expect(policy?.reportOnly).toBe(false);
  });

  it("gives the asking request the header-less policy while the gate is closed", async () => {
    harness.env.CSP_ENABLED = "true";

    const asking = await proxyPolicy();
    harness.requestHeaders.clear();
    const plain = await proxyPolicy();

    expect(plain?.reportOnly).toBe(true);
    expect(asking).toEqual(plain);
  });

  it("serves no policy to a request that does not ask while the gate is open", async () => {
    harness.env.ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED = "true";

    const asking = await proxyPolicy();
    harness.requestHeaders.clear();
    const plain = await proxyPolicy();

    expect(asking?.strict).toBe(true);
    expect(plain).toBeUndefined();
  });
});
