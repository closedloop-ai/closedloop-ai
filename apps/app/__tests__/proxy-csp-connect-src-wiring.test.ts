// @vitest-environment node

import type { AppEnvironment } from "@repo/analytics/environment";
import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { expect, test, vi } from "vitest";
import { buildConnectSrc } from "@/lib/content-security-policy";

/**
 * ISS-7218 — proxy.ts must feed the REAL deployment classification into the CSP
 * `connect-src` builder.
 *
 * `buildConnectSrc`'s own suite proves the policy is right for a given set of
 * inputs; only this suite proves proxy.ts hands it the REAL ones — the live
 * `appEnvironment` rather than a constant, and every other argument rather than
 * a dropped or hardcoded one. That wiring is what silently re-breaks the
 * compute-target status stream when it drifts, and the other proxy suites
 * cannot see it — they mock CSP off so the options branch never runs.
 */

const STAGE_API_URL = "https://api.stage.example";

// Every input proxy.ts forwards holds a NON-ZERO value, so dropping any one of
// them from the production `buildConnectSrc` call changes the policy this suite
// reads back (whitlockk, PR #5556). While `gaMeasurementId` was `undefined` and
// `electronHostnames` was `[]`, deleting either argument was unobservable:
// absent and empty produce the same directive.
const forwarded = vi.hoisted(() => ({
  gaMeasurementId: "G-ISS7218",
  electronHostname: "http://localhost:19432",
  electronPort: 19_432,
  realtimeUrl: "wss://realtime.stage.example/realtime",
  docSyncUrl: "wss://doc-sync.closedloop-stage.test/",
}));

const REALTIME_SOCKET_ORIGIN = "wss://realtime.stage.example";
const DOC_SYNC_SOCKET_ORIGIN = "wss://doc-sync.closedloop-stage.test";

// The source `buildConnectSrc` derives from a VALID measurement ID, spelled
// out rather than imported: an expectation read out of the module it polices
// moves with it and cannot fail.
const GA_COLLECT_SOURCE = "https://www.google-analytics.com/";

type CapturedProxyOptions = {
  contentSecurityPolicy?: { directives?: Record<string, string[]> };
};

// Only the half of `NextRequest` the policy callback consumes.
type CspRequest = { headers: Headers };
type CapturedProxyOptionsCallback = (
  request: CspRequest
) => CapturedProxyOptions;

const environmentHolder = vi.hoisted(() => ({ value: "stage" as string }));
const captured = vi.hoisted(() => ({
  resolveOptions: undefined as CapturedProxyOptionsCallback | undefined,
}));

// Clerk resolves an options CALLBACK per request; `connect-src` itself is
// build-time, so any host resolves the directive under test.
vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (
    callback: (auth: ClerkMiddlewareAuth, request: NextRequest) => unknown,
    options: CapturedProxyOptionsCallback
  ) => {
    captured.resolveOptions = options;
    return callback;
  },
}));

vi.mock("@repo/security/proxy", () => ({
  noseconeOptions: {},
  securityMiddleware: () => () => Promise.resolve(new Response(null)),
}));

vi.mock("@repo/analytics/proxy", () => ({
  analyticsMiddleware: () => () => NextResponse.next(),
}));

vi.mock("@/lib/engineer/electron-probe", () => ({
  getPossibleElectronHostnames: () => [
    { hostname: forwarded.electronHostname, port: forwarded.electronPort },
  ],
}));

// The proxy must forward appEnvironment, not a literal. Keep every other export
// real so this mock cannot introduce a second, drifting copy of app configuration.
vi.mock("@/lib/environment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environment")>()),
  get appEnvironment() {
    return environmentHolder.value;
  },
}));

vi.mock("@/env", () => ({
  env: {
    CSP_ENABLED: "true",
    VERCEL_ENV: "production",
    NEXT_PUBLIC_API_URL: STAGE_API_URL,
    NEXT_PUBLIC_GA_MEASUREMENT_ID: forwarded.gaMeasurementId,
    CSP_REPORT_URI: undefined,
    REALTIME_PUBLIC_URL: forwarded.realtimeUrl,
    DOC_SYNC_PUBLIC_URL: forwarded.docSyncUrl,
  },
}));

async function connectSrcForDeployment(
  environment: AppEnvironment
): Promise<string[] | undefined> {
  environmentHolder.value = environment;
  captured.resolveOptions = undefined;
  vi.resetModules();
  await import("@/proxy");
  return capturedConnectSrc();
}

// Read in its own function: the reset assignment above narrows `captured
// .resolveOptions` to `undefined` for the rest of that body, and the mock
// repopulates it during the import in a way control-flow analysis cannot see.
function capturedConnectSrc(): string[] | undefined {
  return captured.resolveOptions?.({
    headers: new Headers({ host: "app.test" }),
  })?.contentSecurityPolicy?.directives?.["connect-src"];
}

test("proxy.ts forwards the deployment environment into connect-src (ISS-7218)", async () => {
  const onStage = await connectSrcForDeployment("stage");
  const onProd = await connectSrcForDeployment("prod");

  const expected = (environment: AppEnvironment) =>
    buildConnectSrc({
      apiUrl: STAGE_API_URL,
      environment,
      gaMeasurementId: forwarded.gaMeasurementId,
      electronHostnames: [forwarded.electronHostname],
      realtimeUrl: forwarded.realtimeUrl,
      docSyncUrl: forwarded.docSyncUrl,
    });

  // A hardcoded constant, or a dropped `environment` argument, collapses these
  // two into the same policy — which is exactly the silent re-break.
  expect(onStage).not.toEqual(onProd);
  expect(onStage).toEqual(expected("stage"));
  expect(onProd).toEqual(expected("prod"));

  // One literal per remaining forwarded input. These never consult
  // `buildConnectSrc`, so they stay red even if a regression reached both the
  // production call and this suite's `expected` at once.
  expect(onStage).toContain(STAGE_API_URL);
  expect(onStage).toContain(GA_COLLECT_SOURCE);
  expect(onStage).toContain(forwarded.electronHostname);
  expect(onStage).toContain(REALTIME_SOCKET_ORIGIN);
  expect(onStage).toContain(DOC_SYNC_SOCKET_ORIGIN);
});

/**
 * Unquoted `self` is the spelling Clerk's `DEFAULT_DIRECTIVES` use; its
 * `formatValue` adds the quotes on the way into the header. Spelled out here
 * rather than imported: an expectation read out of the module it polices moves
 * with it and cannot fail.
 */
const SELF = "self";

/**
 * ISS-9123 — the app's OWN origin has to be in the array `apps/app` hands
 * Clerk, not inherited from Clerk's `connect-src` defaults.
 *
 * The case above cannot see this. It compares the captured directive against
 * `buildConnectSrc`'s own output, so deleting `self` from the builder moves
 * both sides of that equality at once and it stays green — the same
 * self-referential gap the sibling `img-src` pin in
 * `proxy-csp-directives.test.ts` records for its `arrayContaining` matcher.
 *
 * Both classifications, because the stage/prod branch is the only conditional
 * in the builder: a `self` that arrived through it would be absent from prod's
 * enforced policy, which is the deployment this ticket is about.
 *
 * SCOPE, the same as the `img-src` sibling's: this pins the array this repo
 * owns. It does not run Clerk's `handleExistingDirective` /
 * `handleCustomDirective`, so it proves nothing about which branch Clerk takes
 * under a given version — only that the app's origin is stated whichever
 * branch runs, which is what makes the two branches agree.
 */
test("proxy.ts hands Clerk a connect-src that states the app's own origin (ISS-9123)", async () => {
  expect(await connectSrcForDeployment("stage")).toContain(SELF);
  expect(await connectSrcForDeployment("prod")).toContain(SELF);
});
