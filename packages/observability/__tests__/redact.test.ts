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

// ---------------------------------------------------------------------------
// ISS-7086 — URL userinfo credentials, at every host shape
//
// This sink is where a `scheme://user:pass@host` credential used to leak. Until
// ISS-6993 added `urlUserinfoCredential` to the telemetry vocabulary there was
// no URL rule here at all, so the ONLY thing that happened to remove such a
// credential was `EMAIL_VALUE_RE` below `redactSensitiveText` accidentally
// matching `pass@dotted.host` as an email address — and it requires a dotted
// TLD. A bare hostname (`localhost`, `db`, `redis`), an IPv4 literal, and an
// IPv6 literal all fail that rule, so the password reached the Datadog intake
// and the log-drain line in clear. Those are exactly the hosts a local or
// development connection string carries.
//
// The vocabulary now matches the userinfo run itself and the host is no longer
// consulted, so all four shapes are redacted. NOTHING IN THIS PACKAGE PINNED
// THAT: before this block, `redact.test.ts` carried no credentialed-URL case of
// any kind, so removing `urlUserinfoCredential` from the vocabulary left this
// suite — the suite that owns the leaking sink — entirely green while three of
// the four shapes went back to leaking.
//
// Every row here, dotted included, goes red under that removal — the assertions
// are exact-equality, and an email-rule substitution lands on a different span
// than a userinfo-run one. What separates them is the CONSEQUENCE: on the dotted
// row the mutation costs no leak, because the email rule still removes the
// password, whereas on the other three the password reaches the sink verbatim.
// That is why the dotted row is the regression guard rather than the proof, and
// why it must keep its exact-equality assertion instead of a weaker
// `not.toContain`.
//
// There is no `SECRET_PRETEST`-style early bail on this sink; `redactSensitiveText`
// runs both replaces unconditionally. The pretest hazard applies to the
// transcript twin (`@repo/lib/security/redact-secrets`), which has its own cases.
// ---------------------------------------------------------------------------

describe("redactSensitiveText — URL userinfo credentials (ISS-7086)", () => {
  const PASSWORD = "s3cr3tpw";

  it("scrubs the credential when the host is a bare hostname with no dot", () => {
    // The failing shape. `localhost` has no dotted TLD, so the email rule never
    // saw it and the password went to the sink verbatim.
    expect(
      redactSensitiveText(`dial redis://:${PASSWORD}@localhost:6379`)
    ).toBe(`dial ${REDACTED}localhost:6379`);
  });

  it("scrubs the credential for the bare hostnames a compose file actually uses", () => {
    // `db` and `rabbitmq` are service names, not hosts with a public TLD — the
    // single most common way an inline credential reaches an error message.
    expect(redactSensitiveText(`postgres://user:${PASSWORD}@db`)).toBe(
      `${REDACTED}db`
    );
    expect(redactSensitiveText(`amqp://user:${PASSWORD}@rabbitmq`)).toBe(
      `${REDACTED}rabbitmq`
    );
  });

  it("still scrubs the credential when the host IS dotted (regression guard)", () => {
    expect(
      redactSensitiveText(
        `dial postgres://svc_user:${PASSWORD}@db.example.com:5432/app`
      )
    ).toBe(`dial ${REDACTED}db.example.com:5432/app`);
  });

  it("scrubs the credential when the host is an IPv4 literal", () => {
    // The email rule needs LETTERS after the final dot, so a dotted-quad host
    // failed it just as a bare hostname did.
    expect(
      redactSensitiveText(`dial redis://:${PASSWORD}@127.0.0.1:6379`)
    ).toBe(`dial ${REDACTED}127.0.0.1:6379`);
  });

  it("scrubs the credential when the host is a bracketed IPv6 literal", () => {
    expect(redactSensitiveText(`dial redis://:${PASSWORD}@[::1]:6379`)).toBe(
      `dial ${REDACTED}[::1]:6379`
    );
  });

  it("leaves a credential-free URL alone at every one of those host shapes", () => {
    // The other direction: a rule that matched the host rather than the userinfo
    // run would pass every case above and destroy these. Each carries a port, so
    // the port colon is available to stand in for a user/password separator.
    //
    // The first fixture has no `@` at all, so on its own it proves only that
    // there was nothing to match. The three after it each carry a real `@`
    // further along the URL for the password run to scan to, which is what makes
    // them a DECLINE rather than an absence of input — and it is the shape that
    // actually regressed once, in PR #5339's review.
    const bareHost = "dial redis://localhost:6379 timed out";
    expect(redactSensitiveText(bareHost)).toBe(bareHost);

    // Bare hostname, port, and an `@` past the end of the authority. Only the
    // email is replaced; the scheme, host, and port survive.
    expect(
      redactSensitiveText("dial redis://localhost:6379#owner@example.com")
    ).toBe(`dial redis://localhost:6379#${REDACTED}`);

    // The same, at the two IP-literal hosts.
    expect(
      redactSensitiveText("POST http://[::1]:4318#owner@example.com")
    ).toBe(`POST http://[::1]:4318#${REDACTED}`);
    expect(
      redactSensitiveText("GET http://127.0.0.1:8080?email=ops@example.com")
    ).toBe(`GET http://127.0.0.1:8080?email=${REDACTED}`);
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

  it("keeps a bare-hostname connection-string password out of the intake body (ISS-7086)", async () => {
    // The end-to-end form of the block above: the unit assertions prove the
    // vocabulary matches, this proves the match is actually on the wire path a
    // credential travels. `connectionString` is not a sensitive KEY name — it
    // carries none of the fragments in `SENSITIVE_KEY_FRAGMENTS` — so the only
    // thing standing between this password and Datadog is the value rule.
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.2.3");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123def456");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.error("redis connect failed", {
      connectionString: "redis://:s3cr3tpw@localhost:6379",
    });
    await log.flush();

    const raw = fetchMock.mock.calls[0][1].body as string;
    expect(raw).not.toContain("s3cr3tpw");

    const body = parseFlushedBody<{ connectionString: string }>(fetchMock);
    // The host and port survive so the failure stays diagnosable.
    expect(body[0].connectionString).toBe(`${REDACTED}localhost:6379`);
  });
});
