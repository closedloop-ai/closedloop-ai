/**
 * @file content-security-policy.test.ts
 * @description Behavioral tests for the main-process CSP installer
 * (`src/main/content-security-policy.ts`) and the shared policy strings
 * (`src/shared/content-security-policy.ts`). The packaged `app://` renderer
 * otherwise loads with no CSP, so we assert the header is attached to `app://`
 * responses, that non-`app://` (e.g. loopback dev) responses pass through
 * untouched, and that a pre-existing CSP is replaced rather than intersected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { installAppContentSecurityPolicy } from "../src/main/content-security-policy.js";
import {
  CONTENT_SECURITY_POLICY_HEADER,
  CONTENT_SECURITY_POLICY_META,
} from "../src/shared/content-security-policy.js";

type ResponseHeaders = Record<string, string[]>;
type HeadersResult = { responseHeaders: ResponseHeaders };
type HeadersListener = (
  details: { url: string; responseHeaders: ResponseHeaders },
  callback: (result: HeadersResult) => void
) => void;

function makeFakeSession() {
  let listener: HeadersListener | undefined;
  const session = {
    webRequest: {
      onHeadersReceived(fn: HeadersListener) {
        listener = fn;
      },
    },
  };
  return { session, getListener: () => listener };
}

// The installer registers a single session listener (module-scoped idempotency
// guard), so capture it once and exercise it across cases.
const { session, getListener } = makeFakeSession();
installAppContentSecurityPolicy(session as never);
const onHeadersReceived = getListener();

function run(url: string, responseHeaders: ResponseHeaders): HeadersResult {
  let captured: HeadersResult | undefined;
  onHeadersReceived?.({ url, responseHeaders }, (result) => {
    captured = result;
  });
  if (!captured) {
    throw new Error("listener did not invoke the callback");
  }
  return captured;
}

test("registers a single onHeadersReceived listener", () => {
  assert.equal(typeof onHeadersReceived, "function");
});

test("attaches the strict CSP header to app:// responses", () => {
  const result = run("app://renderer/design-system/index.html", {
    "Content-Type": ["text/html"],
  });
  assert.deepEqual(result.responseHeaders["Content-Security-Policy"], [
    CONTENT_SECURITY_POLICY_HEADER,
  ]);
  // Unrelated headers are preserved.
  assert.deepEqual(result.responseHeaders["Content-Type"], ["text/html"]);
});

test("replaces any pre-existing CSP header rather than intersecting", () => {
  const result = run("app://renderer/assets/index.js", {
    "content-security-policy": ["default-src *"],
  });
  assert.deepEqual(result.responseHeaders["Content-Security-Policy"], [
    CONTENT_SECURITY_POLICY_HEADER,
  ]);
  assert.equal(result.responseHeaders["content-security-policy"], undefined);
});

test("leaves non-app:// (loopback dev) responses untouched", () => {
  const headers: ResponseHeaders = { "Content-Type": ["text/html"] };
  const result = run("http://127.0.0.1:5173/design-system/index.html", headers);
  assert.equal(result.responseHeaders["Content-Security-Policy"], undefined);
  assert.deepEqual(result.responseHeaders, headers);
});

test("idempotent install does not register a second listener", () => {
  const { session: second, getListener: getSecond } = makeFakeSession();
  installAppContentSecurityPolicy(second as never);
  assert.equal(getSecond(), undefined);
});

test("header policy locks down the dangerous directives", () => {
  assert.ok(CONTENT_SECURITY_POLICY_HEADER.includes("default-src 'self' app:"));
  assert.ok(CONTENT_SECURITY_POLICY_HEADER.includes("script-src 'self' app:"));
  assert.ok(CONTENT_SECURITY_POLICY_HEADER.includes("object-src 'none'"));
  assert.ok(CONTENT_SECURITY_POLICY_HEADER.includes("frame-ancestors 'none'"));
  // script-src must not allow inline execution.
  assert.ok(
    !CONTENT_SECURITY_POLICY_HEADER.includes(
      "script-src 'self' app: 'unsafe-inline'"
    )
  );
});

test("meta policy omits header-only frame-ancestors", () => {
  // frame-ancestors is ignored in a <meta> tag and only logs a warning there.
  assert.ok(!CONTENT_SECURITY_POLICY_META.includes("frame-ancestors"));
  assert.ok(CONTENT_SECURITY_POLICY_META.includes("default-src 'self' app:"));
});
