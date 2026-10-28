import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deployment shapes written out here, never read back out of the module under
// test: a fixture imported from the policy moves with the policy and cannot
// fail. These are the real API origins app-stage and app-prod are built with —
// the live `app.stage.example` header carries the former's
// `https://*.preview.stage.example` source, the prod header does not.
const STAGE_API_URL = "https://api.stage.example";
const PROD_API_URL = "https://api.closedloop.ai";
// A production-target deployment `getAppEnvironment` cannot classify: no
// explicit label, and an app host that is not the canonical production one, so
// its fallback answers "stage" for something that is not stage.
const UNCLASSIFIED_APP_URL = "https://app-unknown.example.com";
const UNCLASSIFIED_API_URL = "https://api-unknown.example.com";
const REPORT_URI =
  "https://csp-report.browser-intake-datadoghq.com/api/v2/logs";
// The canonical prod host, and the shape Vercel aliases every prod deployment
// under. Written out, never read back out of the modules under test.
const PROD_APP_HOST = "app.closedloop.ai";
const PROD_ALIAS_APP_HOST = "app-prod-gm12y2fpf.preview.stage.example";
const STAGE_APP_HOST = "app.stage.example";
const STAGE_ALIAS_APP_HOST = "app-stage-52hf33zy5.preview.stage.example";
const UNCLASSIFIED_APP_HOST = "app-unknown.example.com";

type ContentSecurityPolicyOptions = {
  strict?: boolean;
  reportOnly?: boolean;
  reportTo?: string;
  directives?: Record<string, string[]>;
};

type AuthMiddlewareOptions = {
  contentSecurityPolicy?: ContentSecurityPolicyOptions;
};

// Only the half of `NextRequest` the policy callback actually consumes. Typing
// it structurally keeps the stand-in cast-free.
type CspRequest = { headers: Headers };
type AuthMiddlewareOptionsCallback = (
  request: CspRequest
) => AuthMiddlewareOptions;

const harness = vi.hoisted(() => ({
  resolveOptions: undefined as AuthMiddlewareOptionsCallback | undefined,
  apiUrl: "",
}));

// Capture the OPTIONS CALLBACK handed to Clerk's middleware wrapper, and
// resolve it per case the way Clerk does (`typeof params === "function" ?
// await params(req) : params`). Capturing it as a plain object instead would
// make every host case below read the same policy and pass vacuously.
//
// `reportOnly` is the whole input Clerk maps to the header NAME —
// `Content-Security-Policy` when false, `Content-Security-Policy-Report-Only`
// when true (@clerk/nextjs `createContentSecurityPolicyHeaders`). That mapping
// is not exercised here, because `@repo/auth/proxy` is mocked away above; this
// suite owns WHICH deployments ask for `reportOnly: false`, not what Clerk does
// with the answer. ISS-9070 took the other half: `packages/auth/__tests__/
// content-security-policy-nonce-forwarding.test.ts` runs the real
// `clerkMiddleware` and pins the emitted header name plus the nonce it replays
// onto the request for the render — a signed-out request needs no live Clerk
// backend, which an earlier version of this comment assumed it did.
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

// The real `content-security-policy` module is deliberately NOT mocked — the
// enforcement predicate under test is the production one.
vi.mock("@/env", () => ({
  get env() {
    return {
      CSP_ENABLED: "true",
      VERCEL_ENV: "production",
      NEXT_PUBLIC_API_URL: harness.apiUrl,
      NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined,
      CSP_REPORT_URI: REPORT_URI,
      CSP_EXTRA_IMG_SRC: undefined,
      CSP_EXTRA_CONNECT_SRC: undefined,
    };
  },
}));

const CLASSIFIER_KEYS = [
  "NEXT_PUBLIC_APP_ENVIRONMENT",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_VERCEL_ENV",
  "VERCEL_ENV",
] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = Object.fromEntries(
    CLASSIFIER_KEYS.map((key) => [key, process.env[key]])
  );
});

afterEach(() => {
  for (const key of CLASSIFIER_KEYS) {
    const previous = originalEnv[key];
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = previous;
    }
  }
});

/**
 * Re-evaluate `apps/app/proxy.ts` for one deployment, then resolve its policy
 * for one request host. `appEnvironment` is module scope, so a per-case
 * environment needs a fresh module registry rather than a re-import of the
 * already-evaluated instance; the host, by contrast, is per request, which is
 * why the policy is resolved rather than read off the module.
 */
async function policyFor({
  appEnvironment,
  appUrl,
  apiUrl,
  requestHost,
}: {
  appEnvironment: string | undefined;
  appUrl: string | undefined;
  apiUrl: string;
  requestHost: string;
}): Promise<ContentSecurityPolicyOptions | undefined> {
  clearCapture();
  harness.apiUrl = apiUrl;

  process.env.VERCEL_ENV = "production";
  Reflect.deleteProperty(process.env, "NEXT_PUBLIC_VERCEL_ENV");
  setOrDelete("NEXT_PUBLIC_APP_ENVIRONMENT", appEnvironment);
  setOrDelete("NEXT_PUBLIC_APP_URL", appUrl);

  vi.resetModules();
  await import("@/proxy");
  return harness.resolveOptions?.({
    headers: new Headers({ host: requestHost }),
  })?.contentSecurityPolicy;
}

// Clearing through a call, not an inline assignment: an assignment in
// `policyFor` would narrow `harness.resolveOptions` to `undefined` for the
// rest of that function, and the re-import that repopulates it is invisible to
// control-flow analysis.
function clearCapture(): void {
  harness.resolveOptions = undefined;
}

function setOrDelete(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

const stagePolicy = (requestHost = STAGE_APP_HOST) =>
  policyFor({
    appEnvironment: "stage",
    appUrl: `https://${STAGE_APP_HOST}`,
    apiUrl: STAGE_API_URL,
    requestHost,
  });

const prodPolicy = (requestHost = PROD_APP_HOST) =>
  policyFor({
    appEnvironment: "production",
    appUrl: `https://${PROD_APP_HOST}`,
    apiUrl: PROD_API_URL,
    requestHost,
  });

describe("proxy CSP enforcement scope (ISS-8437)", () => {
  it("stage sets reportOnly false, and keeps strict plus the report-to intake", async () => {
    const csp = await stagePolicy();

    expect(csp).toBeDefined();
    expect(csp?.reportOnly).toBe(false);
    expect(csp?.strict).toBe(true);
    expect(csp?.reportTo).toBe(REPORT_URI);
  });

  it("production sets reportOnly false, and keeps strict plus the report-to intake", async () => {
    const csp = await prodPolicy();

    expect(csp).toBeDefined();
    expect(csp?.reportOnly).toBe(false);
    expect(csp?.strict).toBe(true);
    expect(csp?.reportTo).toBe(REPORT_URI);
  });

  it("a deployment the classifier cannot label keeps reportOnly true, despite falling back to the stage label", async () => {
    const csp = await policyFor({
      appEnvironment: undefined,
      appUrl: UNCLASSIFIED_APP_URL,
      apiUrl: UNCLASSIFIED_API_URL,
      requestHost: UNCLASSIFIED_APP_HOST,
    });

    expect(csp).toBeDefined();
    expect(csp?.reportOnly).toBe(true);
  });

  it("the stage label alone does not enforce — the API origin has to agree", async () => {
    const csp = await policyFor({
      appEnvironment: "stage",
      appUrl: `https://${STAGE_APP_HOST}`,
      apiUrl: PROD_API_URL,
      requestHost: STAGE_APP_HOST,
    });

    expect(csp).toBeDefined();
    expect(csp?.reportOnly).toBe(true);
  });
});

/**
 * The prod build answers on TWO hosts and only one of them may enforce
 * (whitlockk, PR #6312). Vercel aliases every prod deployment as
 * `app-prod-<hash>.preview.stage.example`; on that host the browser's
 * `resolveApiOrigin` derives an `api-prod-*` origin that prod's `connect-src`
 * deliberately does not carry, so enforcing there blocks the app-wide API
 * client with nothing server-side to notice.
 *
 * These cases run through the SAME prod deployment as the enforcing case
 * above — one build, two hosts — which is what makes the host the variable
 * under test rather than the environment.
 */
describe("prod enforcement is fenced to the canonical host (PR #6312)", () => {
  it("the prod deployment alias keeps reportOnly true", async () => {
    const csp = await prodPolicy(PROD_ALIAS_APP_HOST);

    expect(csp).toBeDefined();
    expect(csp?.reportOnly).toBe(true);
    // Still the same policy otherwise — the alias reports it, it is not off.
    expect(csp?.strict).toBe(true);
    expect(csp?.reportTo).toBe(REPORT_URI);
  });

  it("a request with no host header keeps reportOnly true", async () => {
    const csp = await prodPolicy("");

    expect(csp).toBeDefined();
    expect(csp?.reportOnly).toBe(true);
  });

  it("stage is NOT fenced — its own alias still enforces", async () => {
    const csp = await stagePolicy(STAGE_ALIAS_APP_HOST);

    expect(csp).toBeDefined();
    expect(csp?.reportOnly).toBe(false);
  });
});

/**
 * ISS-8950 M2 — `script-src` is the directive that actually gates script
 * execution, and until now no test on either web surface referenced it.
 *
 * Asserted against the ENFORCING production and stage resolutions rather than a
 * report-only one, because that is where a gap BLOCKS instead of logging.
 * `strict` — the flag that makes Clerk mint a nonce at all (`const nonce =
 * options.strict ? generateNonce() : void 0`) — is already pinned by the
 * enforcement suite above; these cases add the half nothing covered, and both
 * halves are pinned in this file.
 *
 * Mechanism verified against the resolved `@clerk/nextjs@7.2.5`
 * (`dist/esm/server/content-security-policy.js`), since the absence assertions
 * only mean what they claim if Clerk behaves as stated. The two keys fail
 * DIFFERENTLY, which is why both are pinned:
 *  - `script-src` IS in Clerk's `DEFAULT_DIRECTIVES`, so a value supplied here
 *    is MERGED into its set (`handleExistingDirective`) — additive to the live
 *    script-execution allowlist. `'unsafe-eval'` is the case `proxy.ts` argues
 *    against in prose and nothing pinned, and Clerk itself grants it only while
 *    `NODE_ENV !== "production"`, so in production a supplied one would be the
 *    ONLY source of it.
 *  - `script-src-elem` is NOT in `DEFAULT_DIRECTIVES`, so a value supplied
 *    there is set wholesale (`handleCustomDirective`) and, per CSP3, SHADOWS
 *    `script-src` for `<script>` elements — dropping the nonce and
 *    `'strict-dynamic'` outright rather than widening them.
 *
 * Deliberately NOT a blanket "no script-src ever". Two legitimate edits should
 * redden these and be re-argued rather than slipped through: FEA-4149 deferred
 * a scoped `script-src` HASH as the clean fix for codegen, and supplying
 * `["none"]` for a default-owned directive REPLACES Clerk's set
 * (`handleExistingDirective` lines 90-93) rather than adding to it.
 *
 * Deliberately not asserted: the emitted header string. Clerk builds it behind
 * a non-exported function reached only after authenticating against a live
 * Clerk backend, so this suite pins the options it is built FROM.
 */
describe("proxy CSP script-src integrity (ISS-8950)", () => {
  it("declares no script-src override on the enforcing production policy", async () => {
    const csp = await prodPolicy();

    expect(csp).toBeDefined();
    // Stated so a regression that stopped enforcing could not quietly turn
    // this into a report-only assertion.
    expect(csp?.reportOnly).toBe(false);
    expect(Object.keys(csp?.directives ?? {})).not.toContain(SCRIPT_SRC);
    expect(Object.keys(csp?.directives ?? {})).not.toContain(SCRIPT_SRC_ELEM);
  });

  it("declares no script-src override on the enforcing stage policy either", async () => {
    const csp = await stagePolicy();

    expect(csp).toBeDefined();
    expect(csp?.reportOnly).toBe(false);
    expect(Object.keys(csp?.directives ?? {})).not.toContain(SCRIPT_SRC);
    expect(Object.keys(csp?.directives ?? {})).not.toContain(SCRIPT_SRC_ELEM);
  });
});

// Written out rather than imported from the policy: a fence that reads its
// expectation out of the module it polices moves with that module.
const SCRIPT_SRC = "script-src";
const SCRIPT_SRC_ELEM = "script-src-elem";
