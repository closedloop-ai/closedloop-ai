/**
 * ISS-8950 M2 — `apps/web` had no CSP test of any kind, and `script-src` is the
 * directive that actually gates script execution: it accounts for 230 of this
 * surface's 351 daily report-only violations (measured 2026-09-02). Nothing
 * pinned the inputs this repo controls about it.
 *
 * Mechanism verified against the resolved `@clerk/nextjs@7.2.5`
 * (`dist/esm/server/content-security-policy.js`), because the two absence
 * assertions below only mean what they claim if Clerk behaves as stated:
 *
 *  - `strict` is the ONLY reason a nonce exists on this surface at all. Clerk
 *    mints one per request only under it (`const nonce = options.strict ?
 *    generateNonce() : void 0`, line 166) and only then drops the `http:` /
 *    `https:` host-sources that would otherwise let any script run.
 *    `app/[locale]/layout.tsx` threads that nonce into `<GoogleTagManager>` and
 *    the providers, so dropping `strict` silently unhooks the whole mechanism.
 *  - `script-src` IS in Clerk's `DEFAULT_DIRECTIVES`, so a value supplied here
 *    is MERGED into its set (`handleExistingDirective`) — additive to the live
 *    script-execution allowlist. `script-src-elem` is NOT, so a value supplied
 *    there is set wholesale (`handleCustomDirective`) and, per CSP3, then
 *    SHADOWS `script-src` for `<script>` elements, dropping the nonce and
 *    `'strict-dynamic'` entirely. Two different failures, which is why both
 *    keys are pinned rather than just the familiar one.
 *  - `reportOnly`, asserted as `true` to RECORD the current posture rather than
 *    to endorse it. Whether `www` should enforce is deliberately open
 *    (ISS-8949); this case exists so flipping it is a visible edit here.
 *
 * The absence assertions are deliberately NOT a blanket "no script-src ever".
 * Two legitimate edits should redden them and be re-argued rather than slipped
 * through: FEA-4149 deferred a scoped `script-src` HASH as the clean fix for
 * codegen, and supplying `["none"]` for a default-owned directive REPLACES
 * Clerk's set (`handleExistingDirective` lines 90-93) rather than adding to it,
 * which is a tightening.
 *
 * Deliberately not asserted: the emitted header string. Clerk builds it behind
 * a non-exported function reached only after authenticating against a live
 * Clerk backend, so this suite pins the options it is built FROM.
 */

import { describe, expect, it, vi } from "vitest";

// Written out, never read back out of the module under test: a fence that
// derives its expectation from the value it polices cannot fail.
const CSP_ENABLED = "true";
const SCRIPT_SRC = "script-src";
const SCRIPT_SRC_ELEM = "script-src-elem";
const BASE_URI = "base-uri";
const CONNECT_SRC = "connect-src";
// NOT a fence — this suite injects it through its own `../env` mock below and
// reads it back, so it pins that `CSP_REPORT_URI` is forwarded to Clerk, not
// what the intake URL is.
const REPORT_URI =
  "https://csp-report.browser-intake-datadoghq.com/api/v2/logs";

type ContentSecurityPolicyOptions = {
  strict?: boolean;
  reportOnly?: boolean;
  reportTo?: string;
  directives?: Record<string, string[]>;
};

const harness = vi.hoisted(() => ({
  options: undefined as
    | { contentSecurityPolicy?: ContentSecurityPolicyOptions }
    | undefined,
  cspEnabled: undefined as string | undefined,
}));

// `apps/web` hands Clerk a plain options OBJECT rather than the per-request
// callback `apps/app` uses, so the policy is captured directly.
vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (
    callback: unknown,
    options: { contentSecurityPolicy?: ContentSecurityPolicyOptions }
  ) => {
    harness.options = options;
    return callback;
  },
}));

vi.mock("@repo/security/proxy", () => ({
  noseconeOptions: {},
  securityMiddleware: () => () => Promise.resolve(new Response()),
}));

vi.mock("@repo/internationalization/proxy", () => ({
  internationalizationMiddleware: () => undefined,
}));

vi.mock("@rescale/nemo", () => ({
  createNEMO: () => () => Promise.resolve(undefined),
}));

vi.mock("../env", () => ({
  get env() {
    return { CSP_ENABLED: harness.cspEnabled, CSP_REPORT_URI: REPORT_URI };
  },
}));

describe("apps/web CSP script-src integrity (ISS-8950)", () => {
  it("keeps the policy strict and declares no script-src override", async () => {
    const csp = await policyFor(CSP_ENABLED);

    expect(csp).toBeDefined();
    expect(csp?.strict).toBe(true);

    // Observe the block BEFORE probing it for absences. `Object.keys(x ?? {})`
    // reports "no script-src" just as happily when `directives` was deleted
    // outright, and this is the only CSP coverage apps/web has — so the two
    // keys it does declare are asserted present, or the absence assertions
    // below would survive losing the whole block. `base-uri` is not in Clerk's
    // defaults, so dropping it drops the directive rather than falling back.
    const directiveKeys = Object.keys(csp?.directives ?? {});
    expect(directiveKeys).toContain(BASE_URI);
    expect(directiveKeys).toContain(CONNECT_SRC);

    expect(directiveKeys).not.toContain(SCRIPT_SRC);
    expect(directiveKeys).not.toContain(SCRIPT_SRC_ELEM);
  });

  it("still reports rather than enforces, and forwards CSP_REPORT_URI", async () => {
    const csp = await policyFor(CSP_ENABLED);

    expect(csp?.reportOnly).toBe(true);
    expect(csp?.reportTo).toBe(REPORT_URI);
  });

  it("attaches no policy at all unless CSP_ENABLED is exactly true", async () => {
    // Same trap as the case above, one level out: `policyFor` reads through
    // `harness.options?.contentSecurityPolicy`, so an undefined RESULT is also
    // what a `proxy.ts` that never re-evaluated — or never reached
    // `authMiddleware` at all — would produce. Pin the capture before reading
    // an absence off it, or this case passes on a module that never ran.
    const unset = await policyFor(undefined);
    expect(harness.options).toBeDefined();
    expect(unset).toBeUndefined();

    const notExactlyTrue = await policyFor("1");
    expect(harness.options).toBeDefined();
    expect(notExactlyTrue).toBeUndefined();
  });
});

/**
 * Re-evaluate `apps/web/proxy.ts` for one deployment and return the policy it
 * handed Clerk. The options object is built at module scope, so a per-case
 * `CSP_ENABLED` needs a fresh module registry rather than a re-import of the
 * already-evaluated instance.
 */
async function policyFor(
  cspEnabled: string | undefined
): Promise<ContentSecurityPolicyOptions | undefined> {
  clearCapture();
  harness.cspEnabled = cspEnabled;

  vi.resetModules();
  await import("../proxy");
  return harness.options?.contentSecurityPolicy;
}

// Clearing through a call, not an inline assignment: an assignment here would
// narrow `harness.options` to `undefined` for the rest of the function, and the
// re-import that repopulates it is invisible to control-flow analysis.
function clearCapture(): void {
  harness.options = undefined;
}
