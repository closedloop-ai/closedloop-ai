import { afterEach, describe, expect, it, vi } from "vitest";
import { isSensitiveKey, redactLogValue, redactSensitiveText } from "../redact";
import { importLogWithFetch, parseFlushedBody } from "./test-helpers";

// ---------------------------------------------------------------------------
// redact.ts — centralized redaction of secrets/PII in structured log metadata
// ---------------------------------------------------------------------------

const REDACTED = "[redacted]";

describe("isSensitiveKey", () => {
  it("matches secret/auth/PII key names regardless of casing or separators", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "API-KEY",
      "datadogApiKey",
      "accessToken",
      "refresh_token",
      "sessionToken",
      "token",
      "password",
      "passphrase",
      "clientSecret",
      "secret",
      "authorization",
      "Cookie",
      "setCookieHeader",
      "userEmail",
      "email",
      "awsSecretAccessKey",
      "credentials",
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it("does NOT match token-count metric fields or other benign keys", () => {
    for (const key of [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "tokenUsage",
      "tokenCount",
      "category",
      "model",
      "reason",
      "surface",
      "message",
      "level",
      "durationMs",
      "",
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe("redactSensitiveText", () => {
  it("scrubs secret-shaped tokens embedded in free text", () => {
    expect(
      redactSensitiveText("auth: Bearer abcdef0123456789ABCDEF")
    ).toContain(REDACTED);
    expect(redactSensitiveText("key is sk_live_abc123def456")).toBe(
      `key is ${REDACTED}`
    );
    expect(
      redactSensitiveText("token gho_0123456789abcdef0123456789abcdef")
    ).toBe(`token ${REDACTED}`);
  });

  it("scrubs EVERY secret in one string, not just the first", () => {
    // ISS-6233 moved the pattern to `@closedloop-ai/loops-api/secret-value-pattern`,
    // which exports a non-global `.test()` twin beside the global `.replace()`
    // one. Importing the wrong twin here still scrubs the FIRST secret in a
    // string and ships the rest to the Datadog intake and the log drain — every
    // other case above carries a single secret, so all of them stay green under
    // that mutation. This one does not.
    expect(
      redactSensitiveText(
        "a sk_live_abc123def456 and gho_0123456789abcdef0123456789abcdef"
      )
    ).toBe(`a ${REDACTED} and ${REDACTED}`);
  });

  it("scrubs a bare Google OAuth access token carrying no Bearer prefix", () => {
    // googleapis quotes the offending credential bare in its error text, so the
    // `bearer …` alternative never sees it. Asserted separately from the
    // prefixed form below precisely because only one of the two was covered.
    expect(
      redactSensitiveText("Invalid Credentials: ya29.a0AfH6SMBx7Qm-3lKd_9Zt")
    ).toBe(`Invalid Credentials: ${REDACTED}`);
  });

  it("scrubs a Google refresh token", () => {
    expect(
      redactSensitiveText("refresh failed for 1//04dXm9_Kq2LpZr7TnVw3Ye8Bs")
    ).toBe(`refresh failed for ${REDACTED}`);
  });

  it("leaves a slash-heavy file path alone despite the Google token rule", () => {
    // Google OAuth tokens are base64url and contain no "/", so the `1//` rule
    // must not accept one — otherwise an ordinary path segment starting "1//"
    // is long enough to match and a diagnostic log line is redacted away.
    const path = "failed reading /1//some/long/path/segments/here";
    expect(redactSensitiveText(path)).toBe(path);
  });

  it("scrubs email addresses", () => {
    expect(redactSensitiveText("from user jane.doe@example.com here")).toBe(
      `from user ${REDACTED} here`
    );
  });

  it("leaves benign text untouched", () => {
    const text = "loaded 5 rows in 12ms for category=db.query";
    expect(redactSensitiveText(text)).toBe(text);
  });
});

describe("redactLogValue", () => {
  it("redacts the whole value when the key is sensitive", () => {
    expect(redactLogValue("apiKey", "sk_live_xyz")).toBe(REDACTED);
    expect(redactLogValue("accessToken", "anything-at-all")).toBe(REDACTED);
    expect(redactLogValue("password", 12_345)).toBe(REDACTED);
  });

  it("preserves null/undefined for sensitive keys (don't fabricate a value)", () => {
    expect(redactLogValue("apiKey", undefined)).toBeUndefined();
    expect(redactLogValue("apiKey", null)).toBeNull();
  });

  it("emits no marker when a sensitive key holds empty/blank content (AGENTS.md)", () => {
    // No non-empty sensitive content was matched, so no "[redacted]" marker.
    expect(redactLogValue("apiKey", "")).toBe("");
    expect(redactLogValue("password", "   ")).toBe("   ");
  });

  it("scrubs secret-shaped string values under benign keys", () => {
    expect(redactLogValue("note", "contact ops@example.com")).toBe(
      `contact ${REDACTED}`
    );
  });

  it("passes through non-sensitive scalar values", () => {
    expect(redactLogValue("inputTokens", 100)).toBe(100);
    expect(redactLogValue("category", "db.query")).toBe("db.query");
  });
});

// ---------------------------------------------------------------------------
// Integration — redaction is applied to the Datadog HTTP intake batch payload
// ---------------------------------------------------------------------------

describe("log meta redaction reaches the Datadog intake body", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("redacts sensitive meta keys and secret-shaped values before shipping", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    // Set version/git_sha so the module-load fallback warnings don't get
    // buffered ahead of our entry (they would otherwise occupy body[0]/[1]).
    vi.stubEnv("RELEASE_VERSION", "1.2.3");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123def456");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("user authenticated", {
      apiKey: "sk_live_supersecretvalue",
      userEmail: "jane.doe@example.com",
      note: "logged in via gho_0123456789abcdef0123456789abcdef token",
      inputTokens: 42,
    });
    await log.flush();

    const raw = fetchMock.mock.calls[0][1].body as string;
    expect(raw).not.toContain("sk_live_supersecretvalue");
    expect(raw).not.toContain("jane.doe@example.com");
    expect(raw).not.toContain("gho_0123456789abcdef0123456789abcdef");

    const body = parseFlushedBody<{
      apiKey: string;
      userEmail: string;
      note: string;
      inputTokens: number;
      message: string;
    }>(fetchMock);
    expect(body[0].apiKey).toBe(REDACTED);
    expect(body[0].userEmail).toBe(REDACTED);
    expect(body[0].note).toContain(REDACTED);
    // Non-sensitive metric fields are preserved.
    expect(body[0].inputTokens).toBe(42);
    expect(body[0].message).toBe("user authenticated");
  });
});
