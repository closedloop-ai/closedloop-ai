/**
 * @file external-url-allowlist.test.ts
 * @description Behavioral tests for the shared main-process external-URL
 * allowlist (`src/main/settings/external-url-allowlist.ts`). The allowlist is the single
 * gate every `shell.openExternal` caller (window.ts navigation guards and the
 * `desktop:db:open-pr` IPC handler) routes through, so its fail-closed policy is
 * exercised directly here rather than only via source-text assertions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAllowedDesktopVerificationUrl,
  isAllowedExternalUrl,
  isAllowedRendererExternalUrl,
} from "../src/main/settings/external-url-allowlist.js";

test("isAllowedExternalUrl allows https URLs on known hosts", () => {
  assert.equal(isAllowedExternalUrl("https://github.com/closedloop-ai"), true);
  assert.equal(isAllowedExternalUrl("https://app.closedloop.ai/loops"), true);
  assert.equal(isAllowedExternalUrl("https://closedloop.ai"), true);
  assert.equal(isAllowedExternalUrl("https://docs.closedloop.ai/start"), true);
});

test("isAllowedExternalUrl rejects non-https schemes forwarded to the OS", () => {
  // The whole point of routing through this gate: shell.openExternal hands
  // non-http schemes to the OS, so file:/custom-scheme values must be denied.
  assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedExternalUrl("http://github.com"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("custom-scheme://github.com"), false);
});

test("isAllowedExternalUrl rejects unknown hosts", () => {
  assert.equal(isAllowedExternalUrl("https://evil.com"), false);
  assert.equal(isAllowedExternalUrl("https://github.com.evil.com"), false);
});

test("isAllowedExternalUrl rejects embedded credentials", () => {
  assert.equal(isAllowedExternalUrl("https://user:pass@github.com"), false);
  assert.equal(isAllowedExternalUrl("https://user@github.com"), false);
});

test("isAllowedExternalUrl rejects unparseable input", () => {
  assert.equal(isAllowedExternalUrl("not a url"), false);
  assert.equal(isAllowedExternalUrl(""), false);
});

const CONNECT_PATH = "/settings/integrations/desktop/connect?code=ABCD";

test("isAllowedDesktopVerificationUrl accepts the configured origin (prod, stage, or any https host)", () => {
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://app.closedloop.ai${CONNECT_PATH}`,
      "https://app.closedloop.ai"
    ),
    true
  );
  // A stage/preview host works purely because it is what the desktop is
  // configured to talk to — no fixed prod-host allowlist is involved.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://app.stage.closedloop.dev${CONNECT_PATH}`,
      "https://app.stage.closedloop.dev"
    ),
    true
  );
});

test("isAllowedDesktopVerificationUrl allows http only for loopback dev origins", () => {
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://localhost:3000${CONNECT_PATH}`,
      "http://localhost:3000"
    ),
    true
  );
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://127.0.0.1:3000${CONNECT_PATH}`,
      "http://127.0.0.1:3000"
    ),
    true
  );
  // http to a non-loopback host is rejected even if that is the configured
  // origin — sign-in over a public network must be https.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://app.example.com${CONNECT_PATH}`,
      "http://app.example.com"
    ),
    false
  );
});

test("isAllowedDesktopVerificationUrl rejects a URL whose origin differs from the configured one", () => {
  // MITM/redirect to another host.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://evil.com${CONNECT_PATH}`,
      "https://app.closedloop.ai"
    ),
    false
  );
  // Different port.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://localhost:9999${CONNECT_PATH}`,
      "http://localhost:3000"
    ),
    false
  );
  // Scheme downgrade.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://app.closedloop.ai${CONNECT_PATH}`,
      "https://app.closedloop.ai"
    ),
    false
  );
});

test("isAllowedDesktopVerificationUrl rejects non-web schemes, credentials, and unparseable input", () => {
  assert.equal(
    isAllowedDesktopVerificationUrl(
      "file:///etc/passwd",
      "https://app.closedloop.ai"
    ),
    false
  );
  assert.equal(
    isAllowedDesktopVerificationUrl(
      "app-evil://app.closedloop.ai",
      "https://app.closedloop.ai"
    ),
    false
  );
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://user:pass@app.closedloop.ai${CONNECT_PATH}`,
      "https://app.closedloop.ai"
    ),
    false
  );
  assert.equal(
    isAllowedDesktopVerificationUrl("not a url", "https://app.closedloop.ai"),
    false
  );
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://app.closedloop.ai${CONNECT_PATH}`,
      "garbage"
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// ISS-4898 (wongk + codex review) — `isAllowedRendererExternalUrl`: the fixed
// production host set PLUS the exact origin this desktop is configured against.
//
// Without the second half, the session-detail linked-artifact pills rendered as
// live anchors on every stage/preview/localhost profile and every click was
// silently denied here — a control that looks actionable and does nothing.
// ---------------------------------------------------------------------------

const STAGE_ORIGIN = "https://app.closedloop-stage.ai";
const STAGE_ARTIFACT_URL = `${STAGE_ORIGIN}/acme/issues/ISS-4898`;

test("ISS-4898: the fixed production host set is admitted with no configured origin", () => {
  assert.equal(
    isAllowedRendererExternalUrl(
      "https://app.closedloop.ai/acme/issues/ISS-4898",
      null
    ),
    true
  );
  assert.equal(
    isAllowedRendererExternalUrl("https://github.com/org/repo/pull/1", null),
    true
  );
});

test("ISS-4898: a stage artifact URL is DENIED without the configured origin and ADMITTED with it", () => {
  // The regression itself: the fixed host set alone rejects the very URL the
  // stage-pointed renderer builds.
  assert.equal(isAllowedRendererExternalUrl(STAGE_ARTIFACT_URL, null), false);
  assert.equal(
    isAllowedRendererExternalUrl(STAGE_ARTIFACT_URL, STAGE_ORIGIN),
    true
  );
});

test("ISS-4898: a localhost dev profile is admitted over loopback http", () => {
  assert.equal(
    isAllowedRendererExternalUrl(
      "http://localhost:3000/acme/issues/ISS-4898",
      "http://localhost:3000"
    ),
    true
  );
});

test("ISS-4898: the configured origin admits ONLY that exact origin", () => {
  // Configuring stage must not widen the gate to a sibling host, another port,
  // a downgraded scheme, or a credential-bearing URL.
  for (const url of [
    "https://evil.closedloop-stage.ai/acme/issues/ISS-4898",
    "https://app.closedloop-stage.ai:8443/acme/issues/ISS-4898",
    "http://app.closedloop-stage.ai/acme/issues/ISS-4898",
    "https://user:pass@app.closedloop-stage.ai/acme/issues/ISS-4898",
    "app-evil://app.closedloop-stage.ai/acme",
    "not a url",
  ]) {
    assert.equal(
      isAllowedRendererExternalUrl(url, STAGE_ORIGIN),
      false,
      `must deny ${url}`
    );
  }
});

test("ISS-4898: a malformed configured origin never widens the gate", () => {
  assert.equal(
    isAllowedRendererExternalUrl(STAGE_ARTIFACT_URL, "garbage"),
    false
  );
  // The fixed set still applies, so docs/GitHub links keep working.
  assert.equal(
    isAllowedRendererExternalUrl("https://docs.closedloop.ai/start", "garbage"),
    true
  );
});
