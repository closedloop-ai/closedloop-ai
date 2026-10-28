import { describe, expect, it } from "vitest";
import {
  type BoundedSecretValueFamily,
  SECRET_VALUE_BOUNDED_SOURCE,
  SECRET_VALUE_FAMILY_SOURCE,
  SECRET_VALUE_PATTERN,
  SECRET_VALUE_REPLACE_PATTERN,
  SECRET_VALUE_SELF_ANCHORED_SOURCE,
  type SecretValueFamily,
  type SelfAnchoredSecretValueFamily,
  UNBOUNDED_SECRET_VALUE_PATTERN,
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
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  googleAccessToken: "ya29.a0AfH6SMBx7Qm-3lKd_9Zt",
  googleRefreshToken: "1//04dXm9_Kq2LpZr7TnVw3Ye8Bs",
  sendGridKey: "SG.aBcDeFgHiJkLmNoP.qRsTuVwXyZ0123456789abcdefghij",
  githubFineGrainedPat: "github_pat_11ABCDEFG0abcdefghij1234",
  githubToken: "gho_0123456789abcdef0123456789abcdef",
  gitlabPat: "glpat-abcdefghij1234567890",
  npmToken: "npm_abcdefghij1234567890AB",
  resendKey: "re_abcdefghij1234",
  openaiKey: "sk-proj-abcdefghij1234",
  stripeKey: "sk_live_abc123def456",
  slackToken: "xoxb-1234567890-abcdef",
  huggingFaceToken: "hf_aBcDeFgHiJkLmNoPqRsT01",
  groqKey: "gsk_aBcDeFgHiJkLmNoPqRsT01",
  databricksToken: "dapi0123456789abcdef0123456789abcdef",
  figmaToken: "figd_aBcDeFgHiJ-kLmNoPqRsT_01",
  linearApiKey: "lin_api_aBcDeFgHiJkLmNoPqRsT01",
};

/**
 * ISS-6993. The same `tsc`-enforced guard for the families that carry their own
 * anchoring: a second record, because the union of two key sets could not fail
 * `tsc` on a missing member of either.
 */
const SELF_ANCHORED_FIXTURES: Record<SelfAnchoredSecretValueFamily, string> = {
  pemPrivateKeyBlock:
    "-----BEGIN RSA PRIVATE KEY----- MIIBOgIBAAJBAKj34GkxFhD90vcNLYLI -----END RSA PRIVATE KEY-----",
};

/**
 * ISS-6993. The bounded families get their own `tsc`-enforced record for the
 * same reason the self-anchored ones do — and because the bounded/unbounded
 * split decides whether a desktop exception field survives, a family silently
 * landing in the wrong object is a behaviour change, not a taxonomy quibble.
 */
const BOUNDED_FIXTURES: Record<BoundedSecretValueFamily, string> = {
  urlUserinfoCredential: "postgres://svc_user:s3cr3t-pw@",
};

// `Object.entries` widens the key to `string`; the records above already fix the
// key domain, so this restores nothing they do not already guarantee.
// `alternative` is compiled here, at module level, rather than per test case.
type SecretCase = { family: string; value: string; alternative: RegExp };

function toCases(
  fixtures: Record<string, string>,
  sources: Record<string, string>
): SecretCase[] {
  return Object.entries(fixtures).map(([family, value]) => ({
    family,
    value,
    alternative: new RegExp(`^(?:${sources[family]})$`, "i"),
  }));
}

const SECRET_CASES: readonly SecretCase[] = [
  ...toCases(SECRET_FIXTURES, SECRET_VALUE_FAMILY_SOURCE),
  ...toCases(SELF_ANCHORED_FIXTURES, SECRET_VALUE_SELF_ANCHORED_SOURCE),
  ...toCases(BOUNDED_FIXTURES, SECRET_VALUE_BOUNDED_SOURCE),
];

/** Every family the whole-field-blanking consumer must still react to. */
const UNBOUNDED_CASES: readonly SecretCase[] = [
  ...toCases(SECRET_FIXTURES, SECRET_VALUE_FAMILY_SOURCE),
  ...toCases(SELF_ANCHORED_FIXTURES, SECRET_VALUE_SELF_ANCHORED_SOURCE),
];

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
  {
    // ISS-6993. `eyJ`-prefixed base64 with no `.` is not a JWT — it is what a
    // base64-encoded JSON payload looks like, and this repo ships one
    // (`docs-bundle-manifest.ts`). The two-segment requirement is the whole
    // discriminator, so this goes red the moment it is relaxed.
    reason:
      "an eyJ-prefixed base64 JSON blob carrying no JWT segment separator",
    value: "eyJzb3VyY2VDb21taXQiOiI1N2U0MzE1YmY0OWUyYzU0ZjUzMmIzNzM0NTQ3OGJk",
  },
  {
    // ISS-6993. A host:port authority is the shape `urlUserinfoCredential` sits
    // next to; only a `@` terminator separates them.
    reason: "a URL with a port and no userinfo credential",
    value: "failed calling http://localhost:4318/v1/traces",
  },
  {
    // ISS-6993. A path segment that merely looks like userinfo — the `:` sits
    // AFTER the first `/`, so the authority carries no credential.
    reason: "a userinfo-shaped run inside a URL path rather than its authority",
    value: "https://api.test/user:pass@example.com/a",
  },
  {
    // PR #5339 review. The port colon stood in for the user/password separator
    // and the password run scanned past the `?` to the `@` in the query, so a
    // credential-free OTLP endpoint matched. The neighbouring fixture above
    // takes a `/` straight after the port, which the class already stopped on —
    // only a `?` or `#` in that position reaches this.
    reason: "a URL with a port whose QUERY merely contains an `@`",
    value: "failed calling http://localhost:4318?email=user@example.com",
  },
  {
    reason: "a URL with a port whose FRAGMENT merely contains an `@`",
    value: "failed calling http://localhost:4318#owner@example.com",
  },
  {
    // ISS-6993. A public certificate is not a private key. `PRIVATE KEY` is
    // literal in the alternative, and this fixture is what proves it.
    reason: "a PEM block that is a public certificate, not a private key",
    value:
      "-----BEGIN CERTIFICATE----- MIIBkTCB+wIJAKj34 -----END CERTIFICATE-----",
  },
  {
    // ISS-6993. `(?: BLOCK)?` widened the label to reach PGP PRIVATE blocks; it
    // must not have reached PGP PUBLIC ones on the way.
    reason: "a PGP block that is a public key, not a private key",
    value:
      "-----BEGIN PGP PUBLIC KEY BLOCK----- mQINBFtx3wgBEAC -----END PGP PUBLIC KEY BLOCK-----",
  },
  {
    // ISS-6993. Brackets `jwt`'s per-segment `{8,}` floor at 7 of 8 on the
    // SECOND segment, so loosening it by one goes red.
    reason: "a JWT whose second segment is one character below the floor",
    value: "eyJhbGciOiJIUzI1NiJ9.abcdefg.signaturebytesgohere",
  },
  {
    // ISS-6993. Brackets `sendGridKey`'s `{16,}` at 15 of 16 on the first
    // segment.
    reason: "a SendGrid key whose id segment is one character below the floor",
    value: "SG.abcdefghij12345.qRsTuVwXyZ0123456789abcdef",
  },
  {
    // ISS-6993. Brackets the URL scheme cap at 17 of a permitted 16. A scheme
    // that long is not real; the cap exists to keep the scan linear, and this is
    // what notices if it is ever removed or widened.
    reason: "a URL whose scheme runs one character past the length cap",
    value: "abcdefghijklmnopq://user:pw@host/path",
  },
  {
    // ISS-6993. Mirrors the transcript twin's floor bracketing, which had no
    // counterpart here despite both files declaring identical body classes.
    // Bodies: hf_/gsk_/figd_/lin_api_ 19 of 20, dapi 31 hex of 32.
    reason: "vendor bodies one character below each family's floor",
    value:
      "hf_abcdefghijklmnopqrs gsk_abcdefghijklmnopqrs figd_abcdefghijklmnopqrs lin_api_abcdefghijklmnopqrs dapi0123456789abcdef0123456789abcde",
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
  it("assembles byte-for-byte to the pinned source", () => {
    // The golden. It began (ISS-6233) as the literal both deleted copies
    // (packages/observability/redact.ts and
    // apps/desktop/src/shared/exception-sanitizer.ts) held, so that the hoist
    // could be proven to redact no less than they did. The fixture cases above
    // stay green under a narrowed quantifier or a dropped `\b` — they are short
    // synthetic strings sitting comfortably inside each rule — so without this a
    // future narrowing lands silently. Update it only when the change to the
    // family set is the deliberate point of the diff.
    //
    // ISS-6992 widened `resendKey`'s body class and added `r` to `githubToken`.
    // ISS-6993 added `jwt`, `sendGridKey`, `huggingFaceToken`, `groqKey`,
    // `databricksToken`, `figmaToken`, `linearApiKey`, and — OUTSIDE the shared
    // `\b(?: … )\b` wrapper, which would make them unmatchable — the two
    // self-anchored families. That outer `(?: … )` is load-bearing: it is what
    // keeps the wrapper scoped to the word-anchored alternation.
    //
    // PR #5339's review then added `?` and `#` to both `urlUserinfoCredential`
    // classes. That is a NARROWING of one family and the deliberate point of
    // that diff — the only kind of edit this golden is meant to accept.
    expect(SECRET_VALUE_PATTERN.source).toBe(
      String.raw`(?:\b(?:bearer\s+[A-Za-z0-9._~+\/-]{12,}=*|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,3}|ya29\.[A-Za-z0-9._~+-]{10,}=*|1\/\/[A-Za-z0-9._~+-]{20,}=*|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[oprsu]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|re_[A-Za-z0-9_]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{6,}|sk_(?:live|test)_[A-Za-z0-9]{6,}|xox[baprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|dapi[a-fA-F0-9]{32,}|figd_[A-Za-z0-9_-]{20,}|lin_api_[A-Za-z0-9]{20,})\b|-----BEGIN(?:[A-Z ]+)?PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END(?:[A-Z ]+)?PRIVATE KEY(?: BLOCK)?-----|[^\n]*(?:\n[A-Za-z0-9+/=]+(?=\n|$))*)|\b[a-z][a-z0-9+.-]{0,15}:\/\/[^\s\/:@?#]*:[^\s\/@?#]+@)`
    );
  });

  it("still matches a userinfo credential whose URL carries a query", () => {
    // The positive half of the `?`/`#` stop. Narrowing the classes must not buy
    // its benign cases by redacting less: here the `@` arrives BEFORE the `?`,
    // which is where a real credential always sits, so this must stay matched.
    expect(
      SECRET_VALUE_PATTERN.test(
        "dial postgres://svc:hunter2pw@db.internal:5432/app?sslmode=require"
      )
    ).toBe(true);
  });

  it.each(SECRET_CASES)("matches an embedded $family", (secretCase) => {
    expect(
      SECRET_VALUE_PATTERN.test(`context before ${secretCase.value} after`)
    ).toBe(true);
  });

  it.each(BENIGN_FIXTURES)("leaves alone $reason", ({ value }) => {
    expect(SECRET_VALUE_PATTERN.test(value)).toBe(false);
  });

  it("matches a SEGMENTED Resend key whose first segment is under 10 chars (ISS-6992)", () => {
    // The headline defect. `re_[A-Za-z0-9]{10,}` could not cross the underscore,
    // so this key — the shape Resend actually issues — reached the Datadog
    // intake, the log-drain line, and the desktop exception path in clear.
    // Anchored to `resendKey` itself so a neighbouring alternative that happens
    // to accept it cannot stand in for the fix.
    const segmented = "re_Ci3boZv4_JQZgKbF8xN2Yh7pQrTvWxYz";
    expect(
      new RegExp(`^(?:${SECRET_VALUE_FAMILY_SOURCE.resendKey})$`, "i").test(
        segmented
      )
    ).toBe(true);
    expect(
      SECRET_VALUE_PATTERN.test(`send failed for ${segmented} at 500`)
    ).toBe(true);
  });

  it("matches a GitHub ghr_ refresh token (ISS-6992)", () => {
    // The `gh[opsu]_` / `gh[pousr]_` asymmetry: `r` was absent here while the
    // transcript twin carried it, so a refresh token was redacted in a preview
    // and shipped to telemetry in clear. Anchored to `githubToken` so the
    // assertion cannot be satisfied by another family.
    const refreshToken = "ghr_0123456789abcdef0123456789abcdef";
    expect(
      new RegExp(`^(?:${SECRET_VALUE_FAMILY_SOURCE.githubToken})$`, "i").test(
        refreshToken
      )
    ).toBe(true);
    expect(SECRET_VALUE_PATTERN.test(`refresh with ${refreshToken}`)).toBe(
      true
    );
  });

  it("matches a PEM private-key block truncated by an upstream length cap (ISS-6993)", () => {
    // Every consumer here caps its field, so a header with no footer is the
    // EXPECTED shape. Without the truncation alternative the body walks out in
    // clear and only the header is visible as evidence that it did.
    expect(
      SECRET_VALUE_PATTERN.test(
        "config: -----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAABG5vbmU"
      )
    ).toBe(true);
  });

  it("matches a PGP-armored private key block (ISS-6993)", () => {
    // `gpg --export-secret-keys --armor` is the ordinary way a human moves a
    // private key, and its label is `PGP PRIVATE KEY BLOCK-----` — the literal
    // `PRIVATE KEY-----` never occurs in it, so without `(?: BLOCK)?` this
    // alternative could not match it at any offset and the key walked out of
    // every sink in clear.
    expect(
      SECRET_VALUE_PATTERN.test(
        "-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v1\n\nlQOYBFtx3wgBCAC1v9dq5f3v2z8x\n-----END PGP PRIVATE KEY BLOCK-----"
      )
    ).toBe(true);
  });

  it("matches a bare PKCS8 header carrying no algorithm word (ISS-6993)", () => {
    expect(
      SECRET_VALUE_PATTERN.test(
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----"
      )
    ).toBe(true);
  });

  it("matches a 5-segment compact JWE, not just its first three (ISS-6993)", () => {
    // A JWE is `header.encryptedKey.iv.ciphertext.tag`. With only one optional
    // trailing segment the marker landed after segment three and left `iv`,
    // `ciphertext`, and `tag` sitting in clear right beside it.
    const jwe =
      "eyJhbGciOiJSU0EtT0FFUCJ9.QR9BdEtleU1hdGVyaWFs.aXZpdml2aXZpdg.Y2lwaGVydGV4dGJ5dGVz.dGFnYnl0ZXNoZXJl";
    expect(
      `sent ${jwe} onward`.replace(SECRET_VALUE_REPLACE_PATTERN, "[redacted]")
    ).toBe("sent [redacted] onward");
  });

  it("matches an alg:none JWS whose signature segment is empty (ISS-6993)", () => {
    expect(
      SECRET_VALUE_PATTERN.test(
        "token eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0."
      )
    ).toBe(true);
  });

  it.each([
    {
      host: "a bare hostname carrying no dot",
      value: "dial redis://:s3cr3tpw@localhost:6379",
      expected: "dial [redacted]localhost:6379",
    },
    {
      host: "a bare compose service name",
      value: "dial postgres://user:s3cr3tpw@db",
      expected: "dial [redacted]db",
    },
    {
      host: "a dotted host",
      value: "dial postgres://svc_user:s3cr3tpw@db.example.com:5432/app",
      expected: "dial [redacted]db.example.com:5432/app",
    },
    {
      host: "an IPv4 literal",
      value: "dial redis://:s3cr3tpw@127.0.0.1:6379",
      expected: "dial [redacted]127.0.0.1:6379",
    },
    {
      host: "a bracketed IPv6 literal",
      value: "dial redis://:s3cr3tpw@[::1]:6379",
      expected: "dial [redacted][::1]:6379",
    },
  ])(
    "scrubs a userinfo credential pointed at $host (ISS-7086)",
    ({ value, expected }) => {
      // The alternative terminates at its `@`, so the host is never consulted
      // and all five shapes are one behaviour. That is the POINT: until
      // ISS-6993 added this family there was no URL rule on the Datadog /
      // log-drain sink at all, and the only thing removing such a credential
      // was that sink's email rule incidentally matching `pass@dotted.host` —
      // which needs a dotted TLD, so exactly the bare-hostname and IP-literal
      // rows here leaked. Pinning every row is what stops a future narrowing
      // from reintroducing a host assumption while the dotted row stays green.
      //
      // Anchored to `urlUserinfoCredential` itself first, so no neighbouring
      // alternative can stand in for it.
      expect(
        new RegExp(
          `^(?:${SECRET_VALUE_BOUNDED_SOURCE.urlUserinfoCredential})`,
          "i"
        ).test(value.slice("dial ".length))
      ).toBe(true);
      expect(value.replace(SECRET_VALUE_REPLACE_PATTERN, "[redacted]")).toBe(
        expected
      );
      expect(
        value.replace(SECRET_VALUE_REPLACE_PATTERN, "[redacted]")
      ).not.toContain("s3cr3tpw");
    }
  );

  it("matches a mongodb+srv:// userinfo credential (ISS-6993)", () => {
    // The `+`-bearing scheme the 16-char scheme cap was sized around, and the
    // only scheme shape that exercises the `+` in the scheme character class.
    expect(
      "dial mongodb+srv://svc:pw123@cluster0.example.net/db".replace(
        SECRET_VALUE_REPLACE_PATTERN,
        "[redacted]"
      )
    ).toBe("dial [redacted]cluster0.example.net/db");
  });
});

describe("UNBOUNDED_SECRET_VALUE_PATTERN", () => {
  // ISS-6993. This is the pattern the desktop exception path uses to decide
  // whether to blank an ENTIRE field. It must carry every family whose extent is
  // unknown, and must NOT carry one the consumer can substitute in place — that
  // difference is a whole stack trace, not a nuance.
  it.each(UNBOUNDED_CASES)(
    "still matches an unbounded $family",
    (secretCase) => {
      expect(
        UNBOUNDED_SECRET_VALUE_PATTERN.test(`context ${secretCase.value} after`)
      ).toBe(true);
    }
  );

  it.each(toCases(BOUNDED_FIXTURES, SECRET_VALUE_BOUNDED_SOURCE))(
    "excludes the bounded $family so its consumer can substitute in place",
    (secretCase) => {
      expect(
        SECRET_VALUE_PATTERN.test(`context ${secretCase.value} after`)
      ).toBe(true);
      expect(
        UNBOUNDED_SECRET_VALUE_PATTERN.test(`context ${secretCase.value} after`)
      ).toBe(false);
    }
  );

  it("is non-global, like its parent, so repeated .test() calls stay stateless", () => {
    expect(UNBOUNDED_SECRET_VALUE_PATTERN.global).toBe(false);
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
