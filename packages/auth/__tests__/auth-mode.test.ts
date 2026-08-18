import { afterEach, describe, expect, it } from "vitest";
import {
  AuthMode,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  isLocalTrustedAuthActive,
  isLocalTrustedAuthConfigured,
  isNonProductionEnvironment,
} from "../auth-mode";

// FEA-4334: the whole security boundary of the local_trusted feature lives in
// isLocalTrustedAuthActive. These tests prove: (1) it NEVER grants a synthetic
// session in production/stage/preview — the guard-OFF branch throws rather than
// falling back silently — and (2) it DOES resolve synthetic auth only when the
// explicit non-production signal is set. The env keys these mutate are restored
// EXACTLY in afterEach (deleted when originally unset; never assigned
// "undefined").

const MUTATED_ENV_KEYS = [
  "AUTH_MODE",
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  "NODE_ENV",
  "VERCEL_ENV",
] as const;

const REFUSED_PATTERN = /refused/;

const originalEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

/**
 * Put the process into a clean, fully-explicit non-production local_trusted
 * state: AUTH_MODE=local_trusted, the opt-in signal on, NODE_ENV=test, and no
 * Vercel deploy env. Individual tests then flip exactly one dimension to prove
 * that dimension gates.
 */
function enableLocalTrusted(): void {
  setEnv("AUTH_MODE", AuthMode.LocalTrusted);
  setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
  setEnv("NODE_ENV", "test");
  setEnv("VERCEL_ENV", undefined);
}

describe("auth-mode local_trusted guard", () => {
  afterEach(() => {
    for (const [key, value] of originalEnv) {
      setEnv(key, value);
    }
    originalEnv.clear();
  });

  // Snapshot + clear the keys under test before each case so inherited local/CI
  // state (a real AUTH_MODE, NODE_ENV=production, a VERCEL_ENV) cannot satisfy
  // an earlier branch and mask a regression.
  function isolateEnv(): void {
    for (const key of MUTATED_ENV_KEYS) {
      if (!originalEnv.has(key)) {
        originalEnv.set(key, process.env[key]);
      }
      Reflect.deleteProperty(process.env, key);
    }
  }

  it("defaults to clerk when AUTH_MODE is unset (no synthetic session)", () => {
    isolateEnv();
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "test");

    expect(isLocalTrustedAuthConfigured()).toBe(false);
    expect(isLocalTrustedAuthActive()).toBe(false);
  });

  it("stays clerk when AUTH_MODE=clerk even with the e2e signal set", () => {
    isolateEnv();
    setEnv("AUTH_MODE", AuthMode.Clerk);
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "test");

    expect(isLocalTrustedAuthActive()).toBe(false);
  });

  it("resolves the synthetic session in non-prod with the explicit signal", () => {
    isolateEnv();
    enableLocalTrusted();

    expect(isLocalTrustedAuthConfigured()).toBe(true);
    expect(isNonProductionEnvironment()).toBe(true);
    expect(isLocalTrustedAuthActive()).toBe(true);
  });

  it("THROWS (never grants) when AUTH_MODE=local_trusted in production", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv("NODE_ENV", "production");

    expect(isNonProductionEnvironment()).toBe(false);
    // Guard-OFF branch: must throw, not fall back to clerk and not return true.
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  it("THROWS when AUTH_MODE=local_trusted on a Vercel production deploy", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv("NODE_ENV", "test");
    setEnv("VERCEL_ENV", "production");

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  it("THROWS on a Vercel preview deploy (internet-reachable, must stay gated)", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv("NODE_ENV", "test");
    setEnv("VERCEL_ENV", "preview");

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  it("THROWS when the explicit e2e signal is missing (mode alone is not enough)", () => {
    isolateEnv();
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv("NODE_ENV", "test");
    // E2E_LOCAL_TRUSTED_AUTH intentionally unset.

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  it("THROWS when the e2e signal is any value other than exactly '1'", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "true");

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });
});
