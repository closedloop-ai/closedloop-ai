import { describe, expect, it } from "vitest";
import {
  SECRET_VALUE_FAMILY_SOURCE,
  SECRET_VALUE_PATTERN,
  SECRET_VALUE_REPLACE_PATTERN,
  type SecretValueFamily,
} from "./secret-value-pattern";

/**
 * ISS-6233: the derived guard the hand-copied declarations never had. The
 * `Record<SecretValueFamily, string>` annotation is the load-bearing half —
 * adding a family to `SECRET_VALUE_FAMILY_SOURCE` without a fixture here fails
 * `tsc`, and a fixture for a family that no longer exists fails it too. Both
 * consumers inherit this coverage instead of restating it.
 */
const SECRET_FIXTURES: Record<SecretValueFamily, string> = {
  bearerToken: "Bearer abcdef0123456789ABCDEF",
  googleAccessToken: "ya29.a0AfH6SMBx7Qm-3lKd_9Zt",
  googleRefreshToken: "1//04dXm9_Kq2LpZr7TnVw3Ye8Bs",
  githubFineGrainedPat: "github_pat_11ABCDEFG0abcdefghij1234",
  githubToken: "gho_0123456789abcdef0123456789abcdef",
  gitlabPat: "glpat-abcdefghij1234567890",
  npmToken: "npm_abcdefghij1234567890AB",
  resendKey: "re_abcdefghij1234",
  openaiKey: "sk-proj-abcdefghij1234",
  stripeKey: "sk_live_abc123def456",
  slackToken: "xoxb-1234567890-abcdef",
};

// `Object.entries` widens the key to `string`; the record above already fixes
// the key domain, so this restores it rather than asserting anything new.
// `alternative` is compiled here, at module level, rather than per test case.
const SECRET_CASES: ReadonlyArray<{
  family: SecretValueFamily;
  value: string;
  alternative: RegExp;
}> = Object.entries(SECRET_FIXTURES).map(([family, value]) => ({
  family: family as SecretValueFamily,
  value,
  alternative: new RegExp(
    `^(?:${SECRET_VALUE_FAMILY_SOURCE[family as SecretValueFamily]})$`,
    "i"
  ),
}));

/**
 * Values a redactor must leave alone: over-matching a diagnostic line costs the
 * on-call engineer the very text they need. Each is shaped to sit right next to
 * an alternative it must NOT trip.
 */
const BENIGN_FIXTURES: ReadonlyArray<{ reason: string; value: string }> = [
  {
    // Google OAuth tokens are base64url and contain no "/", so the `1//` rule
    // must not accept one — otherwise an ordinary path segment starting "1//"
    // is long enough to match and a diagnostic log line is redacted away.
    reason: "a slash-heavy file path resembling the 1// refresh-token rule",
    value: "failed reading /1//some/long/path/segments/here",
  },
  {
    reason: "a prefix with nothing after it is below every minimum length",
    value: "saw ya29. and gho_ and sk_live_ prefixes with no token",
  },
  {
    // One character short of `npm_`'s `{20,}` floor. Brackets the boundary, so
    // it goes red if a minimum is loosened by ONE — not only if it is zeroed.
    reason: "a token body one character below its family's minimum length",
    value: "npm_abcdefghij123456789",
  },
];

describe("SECRET_VALUE_FAMILY_SOURCE", () => {
  it.each(SECRET_CASES)("$family matches its own fixture", (secretCase) => {
    // Anchored to the family's OWN alternative, so a fixture that only matches
    // because some neighbouring alternative happens to accept it still fails.
    expect(secretCase.alternative.test(secretCase.value)).toBe(true);
  });
});

describe("SECRET_VALUE_PATTERN", () => {
  it("assembles byte-for-byte to the literal ISS-6233 replaced", () => {
    // The golden. Both deleted copies (packages/observability/redact.ts and
    // apps/desktop/src/shared/exception-sanitizer.ts) held exactly this source,
    // so pinning it proves the hoist redacts no less than they did. The fixture
    // cases above stay green under a narrowed quantifier or a dropped `\b` —
    // they are short synthetic strings sitting comfortably inside each rule —
    // so without this a future narrowing lands silently. Update it only when
    // the change to the family set is the deliberate point of the diff.
    expect(SECRET_VALUE_PATTERN.source).toBe(
      String.raw`\b(?:bearer\s+[A-Za-z0-9._~+\/-]{12,}=*|ya29\.[A-Za-z0-9._~+-]{10,}=*|1\/\/[A-Za-z0-9._~+-]{20,}=*|github_pat_[A-Za-z0-9_]{20,}|gh[opsu]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{6,}|sk_(?:live|test)_[A-Za-z0-9]{6,}|xox[baprs]-[A-Za-z0-9-]{10,})\b`
    );
  });

  it.each(SECRET_CASES)("matches an embedded $family", (secretCase) => {
    expect(
      SECRET_VALUE_PATTERN.test(`context before ${secretCase.value} after`)
    ).toBe(true);
  });

  it.each(BENIGN_FIXTURES)("leaves alone $reason", ({ value }) => {
    expect(SECRET_VALUE_PATTERN.test(value)).toBe(false);
  });

  it("is non-global so repeated .test() calls stay stateless", () => {
    // A global regex carries `lastIndex` across `.test()` calls, so the second
    // call on the same string returns false. Consumers `.test()` this one.
    expect(SECRET_VALUE_PATTERN.global).toBe(false);
    const value = "auth: Bearer abcdef0123456789ABCDEF";
    expect(SECRET_VALUE_PATTERN.test(value)).toBe(true);
    expect(SECRET_VALUE_PATTERN.test(value)).toBe(true);
  });
});

describe("SECRET_VALUE_REPLACE_PATTERN", () => {
  it("is the same expression as SECRET_VALUE_PATTERN, only global", () => {
    expect(SECRET_VALUE_REPLACE_PATTERN.source).toBe(
      SECRET_VALUE_PATTERN.source
    );
    expect(SECRET_VALUE_REPLACE_PATTERN.global).toBe(true);
    expect(SECRET_VALUE_REPLACE_PATTERN.ignoreCase).toBe(
      SECRET_VALUE_PATTERN.ignoreCase
    );
  });

  it.each(SECRET_CASES)("scrubs a $family", (secretCase) => {
    expect(
      `context before ${secretCase.value} after`.replace(
        SECRET_VALUE_REPLACE_PATTERN,
        "[redacted]"
      )
    ).toBe("context before [redacted] after");
  });

  it("scrubs every occurrence, not just the first", () => {
    expect(
      "a sk_live_abc123def456 and gho_0123456789abcdef0123456789abcdef".replace(
        SECRET_VALUE_REPLACE_PATTERN,
        "[redacted]"
      )
    ).toBe("a [redacted] and [redacted]");
  });
});
