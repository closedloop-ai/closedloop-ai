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
