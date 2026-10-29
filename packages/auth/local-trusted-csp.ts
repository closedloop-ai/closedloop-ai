import type { ClerkMiddlewareOptions } from "@clerk/nextjs/server";

/**
 * ISS-12054: the `contentSecurityPolicy` option of `authMiddleware`, applied on
 * the `AUTH_MODE=local_trusted` path, which never enters `clerkMiddleware`.
 *
 * On every other path Clerk builds this header (`createContentSecurityPolicyHeaders`
 * in `@clerk/nextjs/dist/esm/server/content-security-policy.js`), and Clerk does
 * not export that builder. The local path still owes the same policy: the
 * Clerk-free e2e lane serves its enforcing, nonce-bearing policy to the
 * root-layout failure request (ISS-10078), and Next nonces its scripts from the
 * request copy of that header (ISS-9070). So this mirrors Clerk's builder for
 * the installed `@clerk/nextjs` 7.2.5, minus the Clerk Frontend API host, which
 * a session with no Clerk instance has none of.
 * `__tests__/local-trusted-csp-parity.test.ts` runs both against the same
 * options so a Clerk upgrade that moves the defaults fails there.
 */
export type ContentSecurityPolicyOptions = NonNullable<
  ClerkMiddlewareOptions["contentSecurityPolicy"]
>;

const KEYWORDS: ReadonlySet<string> = new Set([
  "none",
  "self",
  "strict-dynamic",
  "unsafe-eval",
  "unsafe-hashes",
  "unsafe-inline",
]);

const NONE = "'none'";
const SURROUNDING_QUOTES = /^'|'$/g;
const NONCE_BYTES = 16;

const ENFORCING_HEADER = "content-security-policy";
const REPORT_ONLY_HEADER = "content-security-policy-report-only";
const REPORTING_ENDPOINTS_HEADER = "reporting-endpoints";
const NONCE_HEADER = "x-nonce";
const OVERRIDE_HEADERS = "x-middleware-override-headers";
const REQUEST_HEADER_PREFIX = "x-middleware-request";

/**
 * Clerk's `DEFAULT_DIRECTIVES`, which it merges every caller's directives into.
 * Read per call because the `unsafe-eval` entry depends on `NODE_ENV`, exactly
 * as Clerk's module-scope evaluation of it does.
 */
function defaultDirectives(): Record<string, string[]> {
  return {
    "connect-src": [
      "self",
      "https://clerk-telemetry.com",
      "https://*.clerk-telemetry.com",
      "https://api.stripe.com",
      "https://maps.googleapis.com",
      "https://img.clerk.com",
      "https://images.clerkstage.dev",
    ],
    "default-src": ["self"],
    "form-action": ["self"],
    "frame-src": [
      "self",
      "https://challenges.cloudflare.com",
      "https://*.js.stripe.com",
      "https://js.stripe.com",
      "https://hooks.stripe.com",
    ],
    "img-src": ["self", "https://img.clerk.com"],
    "script-src": [
      "self",
      ...(process.env.NODE_ENV === "production" ? [] : ["unsafe-eval"]),
      "unsafe-inline",
      "https:",
      "http:",
      "https://*.js.stripe.com",
      "https://js.stripe.com",
      "https://maps.googleapis.com",
    ],
    "style-src": ["self", "unsafe-inline"],
    "worker-src": ["self", "blob:"],
  };
}

/**
 * Set the policy `options` describes on `response`, and replay it onto the
 * request headers the render reads, the way `clerkMiddleware` does.
 */
export function applyLocalTrustedContentSecurityPolicy(
  response: Response,
  requestHeaders: Headers,
  options: ContentSecurityPolicyOptions
): void {
  const headers = buildContentSecurityPolicyHeaders(options, generateNonce());
  for (const [key, value] of headers) {
    response.headers.set(key, value);
  }
  replayOntoRequest(response, requestHeaders, headers);
}

/** The header pairs Clerk would emit for `options`, with `nonce` when strict. */
export function buildContentSecurityPolicyHeaders(
  options: ContentSecurityPolicyOptions,
  nonce: string
): [string, string][] {
  const strictNonce = options.strict ? nonce : undefined;
  let policy = formatPolicy(
    buildDirectives(options.strict ?? false, options.directives, strictNonce)
  );
  const headers: [string, string][] = [];
  if (options.reportTo) {
    policy += "; report-to csp-endpoint";
    headers.push([
      REPORTING_ENDPOINTS_HEADER,
      `csp-endpoint="${options.reportTo}"`,
    ]);
  }
  headers.push([
    options.reportOnly ? REPORT_ONLY_HEADER : ENFORCING_HEADER,
    policy,
  ]);
  if (strictNonce) {
    headers.push([NONCE_HEADER, strictNonce]);
  }
  return headers;
}

function buildDirectives(
  strict: boolean,
  custom: ContentSecurityPolicyOptions["directives"],
  nonce: string | undefined
): Record<string, Set<string>> {
  const directives: Record<string, Set<string>> = {};
  for (const [key, values] of Object.entries(defaultDirectives())) {
    directives[key] = new Set(values);
  }
  const scriptSrc = directives["script-src"] ?? new Set<string>();
  if (strict) {
    scriptSrc.delete("http:");
    scriptSrc.delete("https:");
    scriptSrc.add("'strict-dynamic'");
    if (nonce) {
      scriptSrc.add(`'nonce-${nonce}'`);
    }
  }
  const customDirectives = new Map<string, Set<string>>();
  for (const [key, raw] of Object.entries(custom ?? {})) {
    const values: string[] = Array.isArray(raw) ? raw : [String(raw)];
    const existing = directives[key];
    if (existing) {
      directives[key] = mergeValues(existing, values);
    } else {
      customDirectives.set(key, mergeValues(new Set(), values));
    }
  }
  for (const [key, values] of customDirectives) {
    directives[key] = values;
  }
  return directives;
}

function mergeValues(existing: Set<string>, values: string[]): Set<string> {
  if (values.includes(NONE) || values.includes("none")) {
    return new Set([NONE]);
  }
  const merged = new Set<string>();
  for (const value of [...existing, ...values]) {
    merged.add(formatValue(value));
  }
  return merged;
}

function formatValue(value: string): string {
  const unquoted = value.replace(SURROUNDING_QUOTES, "");
  return KEYWORDS.has(unquoted) ? `'${unquoted}'` : value;
}

function formatPolicy(directives: Record<string, Set<string>>): string {
  return Object.entries(directives)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, values]) => `${key} ${Array.from(values, formatValue).join(" ")}`
    )
    .join("; ");
}

function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** Clerk's `setRequestHeadersOnNextResponse`, which Next reads request overrides from. */
function replayOntoRequest(
  response: Response,
  requestHeaders: Headers,
  headers: [string, string][]
): void {
  if (!response.headers.get(OVERRIDE_HEADERS)) {
    response.headers.set(OVERRIDE_HEADERS, [...requestHeaders.keys()].join());
    requestHeaders.forEach((value, key) => {
      response.headers.set(`${REQUEST_HEADER_PREFIX}-${key}`, value);
    });
  }
  for (const [key, value] of headers) {
    response.headers.set(
      OVERRIDE_HEADERS,
      `${response.headers.get(OVERRIDE_HEADERS)},${key}`
    );
    response.headers.set(`${REQUEST_HEADER_PREFIX}-${key}`, value);
  }
}
