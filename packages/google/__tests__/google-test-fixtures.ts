import { type Mock, vi } from "vitest";

export const CLIENT_ID = "test-client-id";
export const CLIENT_SECRET = "test-client-secret";

export const CLIENT_ID_ENV = "GOOGLE_CLIENT_ID";
export const CLIENT_SECRET_ENV = "GOOGLE_CLIENT_SECRET";

/**
 * A run long enough to trip `redactTokensFromError`'s 40-character floor, so a
 * test can prove a leaked credential never reaches the log (ISS-5291).
 */
export const LEAKED_TOKEN = "b".repeat(60);

/** Under the 40-character floor, so redaction must leave it readable. */
export const DIAGNOSTIC_ERROR_CODE = "redirect_uri_mismatch";

/**
 * `vi.stubEnv` is used rather than direct `process.env` writes so a single
 * `vi.unstubAllEnvs()` restores the exact prior state, including keys that
 * were unset to begin with.
 */
export function setCredentialEnv(): void {
  vi.stubEnv(CLIENT_ID_ENV, CLIENT_ID);
  vi.stubEnv(CLIENT_SECRET_ENV, CLIENT_SECRET);
}

export function clearCredentialEnv(): void {
  vi.stubEnv(CLIENT_ID_ENV, undefined);
  vi.stubEnv(CLIENT_SECRET_ENV, undefined);
}

export function okJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

export function failureResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(text),
  };
}

/**
 * `index.ts` keeps its validated config in a module-level `_config`, so a test
 * that needs a different credential state must load a fresh module instance
 * instead of reusing the one a previous test already warmed.
 */
export function loadGoogleModule() {
  vi.resetModules();
  return import("../index");
}

/**
 * Every argument of every `log.error` call, serialized so one scan covers them
 * all. Reading only `calls[0]` is the ISS-8079 false green: the inner catch
 * logs a redacted body, and the outer catch logs the thrown message as a
 * SECOND call — so a raw body appended to that message leaks past a
 * first-call-only assertion. Both OAuth suites share this, and each owns its
 * own hoisted `logMock`, hence the parameter.
 */
export function allLoggedErrorText(logMock: { error: Mock }): string {
  return logMock.error.mock.calls
    .map((call) => JSON.stringify(call))
    .join("\n");
}
