/**
 * @file content-security-policy.test.ts
 * @description Behavioral tests for the main-process CSP installer
 * (`src/main/settings/content-security-policy.ts`) and the shared policy strings
 * (`src/shared/content-security-policy.ts`). The packaged `app://` renderer
 * otherwise loads with no CSP, so we assert the header is attached to `app://`
 * responses, that non-`app://` (e.g. loopback dev) responses pass through
 * untouched, and that a pre-existing CSP is replaced rather than intersected.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { installAppContentSecurityPolicy } from "../src/main/settings/content-security-policy.js";
import {
  CONTENT_SECURITY_POLICY_HEADER,
  CONTENT_SECURITY_POLICY_META,
  isRendererDisplayableImageUrl,
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

/**
 * Extracts a single directive's full value from a `"; "`-joined CSP string
 * (e.g. `"font-src"` → `"font-src 'self' app: data:"`); undefined when the
 * directive is absent. No directive value contains `"; "`, so the split is
 * unambiguous.
 */
function cspDirective(policy: string, name: string): string | undefined {
  return policy
    .split("; ")
    .find((entry) => entry === name || entry.startsWith(`${name} `));
}

test("connect-src admits only the replay proxy and document collaboration endpoints", () => {
  // REST and attachment bytes remain main-owned. Pin the entire directive so
  // neither the SDK endpoints nor the narrow boundary can silently drift.
  // No document sync host is admitted until ISS-12512 (PLN-2189 T-4.3), and
  // the local service at `ws://localhost:3050` never is: the dev renderer that
  // reaches it runs without a CSP (see the loopback-dev test above).
  const expected =
    "connect-src 'self' app: https://api.closedloop.ai https://api.stage.example https://api.liveblocks.io wss://api.liveblocks.io";
  assert.equal(
    cspDirective(CONTENT_SECURITY_POLICY_HEADER, "connect-src"),
    expected
  );
  // Same lockdown rides the <meta> policy (defense-in-depth).
  assert.equal(
    cspDirective(CONTENT_SECURITY_POLICY_META, "connect-src"),
    expected
  );
});

test("meta policy omits header-only frame-ancestors", () => {
  // frame-ancestors is ignored in a <meta> tag and only logs a warning there.
  assert.ok(!CONTENT_SECURITY_POLICY_META.includes("frame-ancestors"));
  assert.ok(CONTENT_SECURITY_POLICY_META.includes("default-src 'self' app:"));
});

test("allows Clerk avatar images and nothing else remote (ISS-10402)", () => {
  // Every user avatar is served from this host; without it `img-src` blocked
  // all of them. Pinned so a future tightening cannot silently re-break avatars.
  // Asserted as the WHOLE directive, not substring inclusion: an `img-src` that
  // ALSO admitted `https://anything.example` would still contain this text, so
  // equality is what pins the one-host boundary in both directions — the host
  // cannot be dropped, and a second remote origin cannot be added beside it.
  const expectedImgSrc = "img-src 'self' app: data: https://img.clerk.com";
  assert.equal(
    cspDirective(CONTENT_SECURITY_POLICY_HEADER, "img-src"),
    expectedImgSrc
  );
  assert.equal(
    cspDirective(CONTENT_SECURITY_POLICY_META, "img-src"),
    expectedImgSrc
  );
  // Widening any of these would give the renderer a remote code or style path,
  // which the app:// architecture forbids. `connect-src` carries the replay
  // proxy's origins and is pinned whole by the test above.
  for (const directive of ["script-src", "style-src", "font-src"]) {
    const clause = CONTENT_SECURITY_POLICY_HEADER.split("; ").find((part) =>
      part.startsWith(`${directive} `)
    );
    assert.ok(clause, `${directive} is declared`);
    assert.ok(
      !clause.includes("http"),
      `${directive} carries no remote origin: ${clause}`
    );
  }
});

test("the displayable-image predicate admits exactly what img-src does (ISS-11465)", () => {
  // The predicate is what screens the server-supplied organization logo and
  // user avatar before the menu renders them, and `User.avatarUrl` is NOT
  // constrained to Clerk — `PUT /users/:id` accepts any valid URL. A predicate
  // looser than the directive paints a blank `<img>` with no fallback behind
  // it; a stricter one drops a logo the policy would have allowed, so both
  // directions are asserted here.
  assert.equal(
    isRendererDisplayableImageUrl("https://img.clerk.com/avatar.png"),
    true
  );
  assert.equal(
    isRendererDisplayableImageUrl("data:image/png;base64,AAA"),
    true
  );
  assert.equal(
    isRendererDisplayableImageUrl("https://avatars.example.com/ada.png"),
    false
  );
  assert.equal(
    isRendererDisplayableImageUrl("http://img.clerk.com/avatar.png"),
    false
  );
  assert.equal(
    isRendererDisplayableImageUrl("https://evil.example/img.clerk.com"),
    false
  );
  assert.equal(isRendererDisplayableImageUrl("/relative/avatar.png"), false);
  assert.equal(isRendererDisplayableImageUrl(""), false);
});
