/**
 * @file external-url-allowlist.test.ts
 * @description Behavioral tests for the shared main-process external-URL
 * allowlist (`src/main/external-url-allowlist.ts`). The allowlist is the single
 * gate every `shell.openExternal` caller (window.ts navigation guards and the
 * `desktop:db:open-pr` IPC handler) routes through, so its fail-closed policy is
 * exercised directly here rather than only via source-text assertions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAllowedDesktopVerificationUrl,
  isAllowedExternalUrl,
} from "../src/main/external-url-allowlist.js";

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
