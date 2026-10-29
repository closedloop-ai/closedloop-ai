/**
 * Guards the premise every ISS-6742 origin fixture rests on.
 *
 * The route suites assert that `UNTRUSTED_ORIGIN` is rejected. That proves
 * nothing unless the origin really is off the allowlist, so this pins the
 * fixtures against the real `canonicalizeTrustedOrigin`. If a future allowlist
 * change (a new configured origin, a widened preview suffix) makes the attacker
 * origin trusted, this fails here rather than silently draining the assertions
 * in five other files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import {
  stubTrustedOriginEnv,
  TRUSTED_APP_ORIGIN,
  TRUSTED_WEB_ORIGIN,
  UNTRUSTED_ORIGIN,
} from "./trusted-origin.test-helpers";

describe("trusted-origin test fixtures", () => {
  beforeEach(() => {
    stubTrustedOriginEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("canonicalizes both trusted fixtures to themselves", () => {
    expect(canonicalizeTrustedOrigin(TRUSTED_APP_ORIGIN)).toBe(
      TRUSTED_APP_ORIGIN
    );
    expect(canonicalizeTrustedOrigin(TRUSTED_WEB_ORIGIN)).toBe(
      TRUSTED_WEB_ORIGIN
    );
  });

  it("keeps the two trusted fixtures distinct so a mismatch fixture stays a mismatch", () => {
    expect(TRUSTED_APP_ORIGIN).not.toBe(TRUSTED_WEB_ORIGIN);
  });

  it("rejects the untrusted fixture despite it being a well-formed https origin", () => {
    expect(UNTRUSTED_ORIGIN.startsWith("https://")).toBe(true);
    expect(new URL(UNTRUSTED_ORIGIN).origin).toBe(UNTRUSTED_ORIGIN);
    expect(canonicalizeTrustedOrigin(UNTRUSTED_ORIGIN)).toBeNull();
  });
});
