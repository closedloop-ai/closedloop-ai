import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact-secrets.js";

// Synthetic, non-live secret-SHAPED strings. None are real credentials; they
// exist only to exercise the anchors + length/entropy guards.
const A32 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"; // 32 base62 chars

describe("FEAT 019f881c: redactSecrets — each pattern is redacted", () => {
  it("redacts sk_live_ Stripe secret keys", () => {
    const out = redactSecrets(`key=sk_live_${A32} done`);
    expect(out).toContain("[REDACTED:sk_live]");
    expect(out).not.toContain(A32);
    expect(out).toBe("key=[REDACTED:sk_live] done");
  });

  it("redacts sk_test_ and pk_live_ keyed secrets", () => {
    expect(redactSecrets(`sk_test_${A32}`)).toBe("[REDACTED:sk_test]");
    expect(redactSecrets(`pk_live_${A32}`)).toBe("[REDACTED:pk_live]");
  });

  it("redacts whsec_ webhook signing secrets", () => {
    expect(redactSecrets(`whsec_${A32}`)).toBe("[REDACTED:whsec]");
  });

  it("redacts GitHub tokens (ghp_/gho_/ghs_/ghu_/ghr_)", () => {
    for (const prefix of ["ghp", "gho", "ghs", "ghu", "ghr"]) {
      const out = redactSecrets(`token: ${prefix}_${A32}0000`);
      expect(out).toBe(`token: [REDACTED:${prefix}]`);
    }
  });

  it("redacts GitHub fine-grained PATs (github_pat_)", () => {
    expect(redactSecrets(`github_pat_${A32}_${A32}`)).toBe(
      "[REDACTED:github_pat]"
    );
  });

  it("redacts AWS AKIA / ASIA access key ids", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:aws_akia]");
    expect(redactSecrets("ASIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:aws_akia]");
  });

  it("redacts long high-entropy sk- and sk-ant- API keys", () => {
    expect(redactSecrets(`sk-${A32}${A32}`)).toBe("[REDACTED:sk]");
    expect(redactSecrets(`sk-ant-api03-${A32}${A32}`)).toBe(
      "[REDACTED:sk-ant]"
    );
  });

  it("redacts segmented OpenAI API keys", () => {
    expect(redactSecrets(`sk-proj-${A32}${A32}`)).toBe("[REDACTED:sk-openai]");
    expect(redactSecrets(`sk-svcacct-${A32}${A32}`)).toBe(
      "[REDACTED:sk-openai]"
    );
  });

  it("redacts Bearer <token> preserving the scheme word", () => {
    const out = redactSecrets(`Bearer ${A32}.${A32}`);
    expect(out).toBe("Bearer [REDACTED:bearer]");
    expect(out).not.toContain(A32);
  });

  it("redacts lowercase `bearer` (case-insensitive scheme, e.g. curl -H)", () => {
    const out = redactSecrets(`bearer ${A32}${A32}`);
    expect(out).toBe("bearer [REDACTED:bearer]");
    expect(out).not.toContain(A32);
  });

  it("redacts Authorization: header values preserving the header name", () => {
    const out = redactSecrets(`Authorization: Bearer ${A32}${A32}`);
    expect(out.startsWith("Authorization: ")).toBe(true);
    expect(out).toContain("[REDACTED:authorization]");
    expect(out).not.toContain(A32);
  });

  it("redacts Google API keys and Slack tokens", () => {
    // AIza + exactly 35 url-safe chars = 39-char Google API key.
    expect(redactSecrets("AIzaSyD1234567890abcdefghijklmnopqrstuv")).toBe(
      "[REDACTED:google_api_key]"
    );
    expect(redactSecrets("xoxb-1234567890-abcdefghijkl")).toBe(
      "[REDACTED:slack_token]"
    );
  });

  it("redacts multiple secrets in one string", () => {
    const out = redactSecrets(`use sk_live_${A32} and ghp_${A32}0000 together`);
    expect(out).toBe("use [REDACTED:sk_live] and [REDACTED:ghp] together");
  });
});

describe("FEAT 019f881c: redactSecrets — benign prose is NOT over-redacted", () => {
  it("leaves ordinary snake_case words untouched", () => {
    const prose =
      "The sk_helper function reads user_id and live_config from the test_suite.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("does not redact a short sk- fragment or kebab identifier", () => {
    const prose = "install sk-cli and run sk-config-value in test mode";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("does not redact a bare Bearer / Authorization with no credential", () => {
    const prose =
      "Send the Bearer flag; the Authorization: pending until approved.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("does not redact short pk_live_ / sk_live_ with no key body", () => {
    const prose = "the sk_live_ prefix and pk_live_ prefix are documented";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("returns clean text unchanged (fast-path bail)", () => {
    const prose = "Refactored the metadata sanitizer and added a length cap.";
    expect(redactSecrets(prose)).toBe(prose);
    expect(redactSecrets("")).toBe("");
  });

  it("is idempotent — re-redacting a marker is a no-op", () => {
    const once = redactSecrets(`sk_live_${A32}`);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe("FEAT 019f881c: redactSecrets — authorization scheme capture group", () => {
  it("redacts a bare Authorization credential with no scheme word (scheme capture group undefined → '')", () => {
    // The Authorization regex has an optional group ([A-Za-z]+\s+)? for the scheme.
    // When the credential follows directly after "Authorization: " without a scheme
    // word like "Bearer" — i.e. "[A-Za-z]+\s+" cannot match — the group is
    // undefined at runtime, and the replace lambda coerces it via `scheme || ""`
    // (branch 0, arm 1 at line 128). The output still redacts the credential.
    const out = redactSecrets(`Authorization: ${A32}${A32}`);
    expect(out).toBe("Authorization: [REDACTED:authorization]");
    expect(out).not.toContain(A32);
  });
});
