import { describe, expect, it } from "vitest";
import {
  redactSecrets,
  SECRET_PATTERN_LABELS,
  SECRET_PRETEST,
  type SecretPatternLabel,
} from "./redact-secrets.js";

// Synthetic, non-live secret-SHAPED strings. None are real credentials; they
// exist only to exercise the anchors + length/entropy guards.
const A32 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"; // 32 base62 chars
const HEX32 = "0123456789abcdef0123456789abcdef"; // 32 hex chars
// A structurally complete JWT: header.payload.signature, all base64url.
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
// `eyJ`-prefixed base64 of ordinary JSON, carrying NO segment separator. This is
// not a hypothetical: `apps/desktop/src/main/docs-help/docs-bundle-manifest.ts`
// ships one, and it is the shape the JWT rule must decline.
const EYJ_BLOB = "eyJzb3VyY2VDb21taXQiOiI1N2U0MzE1YmY0OWUyYzU0ZjUzMmIz";

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

  it("redacts Google OAuth access (ya29.) and refresh (1//) tokens", () => {
    expect(redactSecrets(`ya29.${A32}`)).toBe("[REDACTED:google_oauth_token]");
    expect(redactSecrets(`1//${A32}`)).toBe("[REDACTED:google_refresh_token]");
  });

  it("redacts GitLab PATs, npm tokens, and Resend API keys", () => {
    expect(redactSecrets(`glpat-${A32}`)).toBe("[REDACTED:gitlab_pat]");
    expect(redactSecrets(`npm_${A32}`)).toBe("[REDACTED:npm]");
    expect(redactSecrets(`re_${A32}`)).toBe("[REDACTED:resend]");
  });

  it("redacts a segmented Resend key (underscore inside the body)", () => {
    expect(redactSecrets("re_Ci3boZv4_JQZgKbF8xN2Yh7pQrTvWxYz")).toBe(
      "[REDACTED:resend]"
    );
  });

  it("redacts a digit-free Resend key body on the length alternative", () => {
    // The digit-entropy alternative cannot see this one — a real key body is
    // random, so an all-letters body is uncommon but not rare. The >= 20 base62
    // floor is what stops it from walking out to the provider.
    expect(redactSecrets("re_AbCdEfGhIjKlMnOpQrStUvWxYz")).toBe(
      "[REDACTED:resend]"
    );
  });

  it("redacts a bare ya29. access token quoted by a googleapis error", () => {
    const out = redactSecrets(
      `Invalid Credentials: request had ya29.${A32} attached`
    );
    expect(out).toBe(
      "Invalid Credentials: request had [REDACTED:google_oauth_token] attached"
    );
    expect(out).not.toContain(A32);
  });

  it("redacts multiple secrets in one string", () => {
    const out = redactSecrets(`use sk_live_${A32} and ghp_${A32}0000 together`);
    expect(out).toBe("use [REDACTED:sk_live] and [REDACTED:ghp] together");
  });
});

describe("ISS-6993: redactSecrets — the three structural credential classes", () => {
  it("redacts a BARE JWT carrying no Bearer prefix", () => {
    const out = redactSecrets(`token expired: ${JWT} at 401`);
    expect(out).toBe("token expired: [REDACTED:jwt] at 401");
    expect(out).not.toContain("eyJ");
  });

  it("keeps the bearer label when the same JWT arrives with its scheme word", () => {
    // The ordering contract. This rule is LAST in SECRET_PATTERNS so the
    // prefixed forms still win where both could match — move it earlier and this
    // says `[REDACTED:jwt]`, silently relabelling every Bearer header.
    expect(redactSecrets(`Bearer ${JWT}`)).toBe("Bearer [REDACTED:bearer]");
    expect(redactSecrets(`Authorization: Bearer ${JWT}`)).toBe(
      "Authorization: Bearer [REDACTED:authorization]"
    );
  });

  it("redacts a PEM private-key block whole, header to footer", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLI\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`deploy key:\n${pem}\nuploaded`);
    expect(out).toBe("deploy key:\n[REDACTED:pem_private_key]\nuploaded");
    expect(out).not.toContain("MIIBOgIBAAJBAKj34GkxFhD90vcNLYLI");
  });

  it("redacts a PEM block truncated by an upstream length cap, under its OWN marker", () => {
    // Every caller hands this function a length-capped string, so a header whose
    // footer was cut off is the EXPECTED shape. Without the truncation
    // alternative the body walks out in clear with only the header as evidence.
    // The distinct label is the contract: a reader must be able to tell "a whole
    // block was replaced" from "no footer existed, so everything visible went".
    const out = redactSecrets(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU"
    );
    expect(out).toBe("[REDACTED:pem_private_key_unterminated]");
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU");
  });

  it("consumes every base64 line of a MULTI-line truncated PEM body", () => {
    // The truncation alternative takes the header's own line plus following
    // whole base64 lines. A fallback that stopped at the first newline would
    // leave lines 2..n of the key in clear.
    const out = redactSecrets(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAvNQZ8Kj34GkxFhD9\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU"
    );
    expect(out).toBe("[REDACTED:pem_private_key_unterminated]");
    expect(out).not.toContain("MIIEowIBAAKCAQEAvNQZ8Kj34GkxFhD9");
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU");
  });

  it("leaves the record terminator and following prose after a truncated PEM", () => {
    // The regression the `|$` terminator caused. `redacted-jsonl-transcript`
    // hands this each line WITH its trailing newline, and in JavaScript `$`
    // without `m` asserts only the true end of input — so the newline was eaten
    // and the record merged with the next one. Asserting the `\n` survives is
    // the whole point; a JSON record whose key ran to its own end still cannot
    // be closed, but it must not swallow its successor.
    const line =
      '{"type":"user","text":"key: -----BEGIN RSA PRIVATE KEY----- MIIBOgIBAAJBAKj34"}\n';
    const out = redactSecrets(line);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toBe(
      '{"type":"user","text":"key: [REDACTED:pem_private_key_unterminated]\n'
    );
    // Prose on a LATER line is not swallowed either — only whole base64 lines are.
    expect(
      redactSecrets(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAvNQZ8Kj34GkxFhD9\nand then we discussed lunch"
      )
    ).toBe(
      "[REDACTED:pem_private_key_unterminated]\nand then we discussed lunch"
    );
  });

  it("redacts a PGP-armored private key block", () => {
    // `gpg --export-secret-keys --armor` labels its block
    // `PGP PRIVATE KEY BLOCK-----`, in which the literal `PRIVATE KEY-----`
    // never occurs — so before `(?: BLOCK)?` this rule could not match it at any
    // offset and a GPG secret key reached the cloud DB, the UI, the JSONL
    // upload, and the coaching payload completely unredacted.
    const out = redactSecrets(
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v1\n\nlQOYBFtx3wgBCAC1v9dq5f3v2z8x\n-----END PGP PRIVATE KEY BLOCK-----"
    );
    expect(out).toBe("[REDACTED:pem_private_key]");
    expect(out).not.toContain("lQOYBFtx3wgBCAC1v9dq5f3v2z8x");
  });

  it("redacts a bare PKCS8 header carrying no algorithm word", () => {
    expect(
      redactSecrets(
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----"
      )
    ).toBe("[REDACTED:pem_private_key]");
  });

  it("consumes a PEM body WHOLE even when it contains another family's shape", () => {
    // Every other PEM fixture uses an inert body no other rule would touch, so
    // this is the only case that pins "one marker, whole body gone" when the
    // body is NOT inert.
    //
    // It does NOT prove the array ordering, and must not be described as if it
    // did: measured both ways, a reorder produces byte-identical output, because
    // the PEM rule's `[\s\S]*?` simply re-consumes whichever marker ran first.
    // What this pins is that the block collapses to exactly ONE marker with no
    // key bytes and no nested marker left behind.
    const body = `MIIBOgIBAAJBAKj34 sk-${A32}${A32} GkxFhD90vcNLYLI`;
    const out = redactSecrets(
      `-----BEGIN RSA PRIVATE KEY----- ${body} -----END RSA PRIVATE KEY-----`
    );
    expect(out).toBe("[REDACTED:pem_private_key]");
    expect(out).not.toContain(A32);
    expect(out).not.toContain("MIIBOgIBAAJBAKj34");
  });

  it("redacts URL userinfo credentials, keeping the scheme, host, and path", () => {
    const out = redactSecrets(
      "dial postgres://svc_user:hunter2pw@db.internal:5432/app failed"
    );
    expect(out).toBe(
      "dial postgres://[REDACTED:url_credentials]@db.internal:5432/app failed"
    );
    expect(out).not.toContain("hunter2pw");
  });

  it("redacts a password-only URL credential with an empty user", () => {
    // `redis://:pw@host` is a real shape, so the user half is optional-width.
    const out = redactSecrets("redis://:s3cr3tpw@cache.local:6379");
    expect(out).toBe("redis://[REDACTED:url_credentials]@cache.local:6379");
    expect(out).not.toContain("s3cr3tpw");
  });

  it("leaves a port-bearing URL whose query or fragment carries an `@`", () => {
    // PR #5339 review. The authority ends at `?` and `#` as surely as at `/`
    // (RFC 3986 3.2), but only `/` was excluded, so the port colon stood in for
    // the user/password separator and the run scanned past the delimiter to the
    // `@` beyond it. This sink then rewrote a credential-free OTLP endpoint to
    // `http://[REDACTED:url_credentials]@example.com` — losing the port and the
    // entire query, which is the diagnostic the on-call engineer needs.
    expect(
      redactSecrets("POST http://localhost:4318?email=user@example.com failed")
    ).toBe("POST http://localhost:4318?email=user@example.com failed");
    expect(redactSecrets("see http://127.0.0.1:8080#owner@example.com")).toBe(
      "see http://127.0.0.1:8080#owner@example.com"
    );
  });

  it("still redacts a userinfo credential on a URL that has a query", () => {
    // The other direction, so the fix above cannot pass by redacting less. The
    // `@` here arrives BEFORE the `?`, which is where a real credential sits,
    // and the query must survive alongside the host and path.
    const out = redactSecrets(
      "dial postgres://svc_user:hunter2pw@db.internal:5432/app?sslmode=require"
    );
    expect(out).toBe(
      "dial postgres://[REDACTED:url_credentials]@db.internal:5432/app?sslmode=require"
    );
    expect(out).not.toContain("hunter2pw");
  });

  it.each([
    {
      host: "a bare hostname carrying no dot",
      value: "dial redis://:s3cr3tpw@localhost:6379",
      expected: "dial redis://[REDACTED:url_credentials]@localhost:6379",
    },
    {
      host: "a bare compose service name",
      value: "dial postgres://user:s3cr3tpw@db",
      expected: "dial postgres://[REDACTED:url_credentials]@db",
    },
    {
      host: "an IPv4 literal",
      value: "dial redis://:s3cr3tpw@127.0.0.1:6379",
      expected: "dial redis://[REDACTED:url_credentials]@127.0.0.1:6379",
    },
    {
      host: "a bracketed IPv6 literal",
      value: "dial redis://:s3cr3tpw@[::1]:6379",
      expected: "dial redis://[REDACTED:url_credentials]@[::1]:6379",
    },
  ])(
    "redacts a URL userinfo credential pointed at $host (ISS-7086)",
    ({ value, expected }) => {
      // Every positive in this describe block above used a DOTTED host
      // (`db.internal`, `cache.local`, `github.com`), which is the shape that
      // survived on the telemetry twin even before that side had a URL rule —
      // its email fallback needs a dotted TLD. These are the shapes that did
      // not, and they are what a local or development connection string
      // actually carries. This rule never consults the host (it terminates at
      // its `@`), so pinning them is what stops a future edit from introducing
      // an assumption about the host while the dotted cases stay green.
      //
      // Pretest: every fixture self-anchors on the `:\/\/[^\s\/@]*:` alternative,
      // so the early bail is defeated by the substring under test itself and not
      // by an unrelated secret carried alongside. The three password-only rows
      // anchor as `://:` — the user run is allowed to be empty and the separator
      // colon follows immediately — and the `postgres://user:…` row as `://user:`.
      const out = redactSecrets(value);
      expect(out).toBe(expected);
      expect(out).not.toContain("s3cr3tpw");
    }
  );

  it("redacts a token used as a URL password before its own family can", () => {
    // The URL rule runs early precisely so the credential is consumed as one
    // unit. Either outcome redacts, but only this one keeps the host.
    const out = redactSecrets(
      `git clone https://x-oauth-token:ghp_${A32}0000@github.com/org/repo.git`
    );
    expect(out).toBe(
      "git clone https://[REDACTED:url_credentials]@github.com/org/repo.git"
    );
    expect(out).not.toContain(A32);
  });
});

describe("ISS-6993: redactSecrets — the six vendor-prefixed key families", () => {
  it("redacts hf_, gsk_, figd_, and lin_api_ keys", () => {
    expect(redactSecrets(`hf_${A32}`)).toBe("[REDACTED:huggingface]");
    expect(redactSecrets(`gsk_${A32}`)).toBe("[REDACTED:groq]");
    expect(redactSecrets(`figd_${A32}`)).toBe("[REDACTED:figma]");
    expect(redactSecrets(`lin_api_${A32}`)).toBe("[REDACTED:linear]");
  });

  it("redacts a SendGrid SG.<id>.<secret> key", () => {
    expect(redactSecrets(`SG.AbCdEfGhIjKlMnOp.${A32}`)).toBe(
      "[REDACTED:sendgrid]"
    );
  });

  it("redacts a 5-segment compact JWE, not just its first three", () => {
    // `header.encryptedKey.iv.ciphertext.tag`. With only one optional trailing
    // segment the marker landed after segment three and left `iv`, `ciphertext`,
    // and `tag` in clear immediately beside it.
    const jwe =
      "eyJhbGciOiJSU0EtT0FFUCJ9.QR9BdEtleU1hdGVyaWFs.aXZpdml2aXZpdg.Y2lwaGVydGV4dGJ5dGVz.dGFnYnl0ZXNoZXJl";
    const out = redactSecrets(`sent ${jwe} onward`);
    expect(out).toBe("sent [REDACTED:jwt] onward");
    expect(out).not.toContain("dGFnYnl0ZXNoZXJl");
  });

  it("redacts an alg:none JWS whose signature segment is empty", () => {
    expect(
      redactSecrets("token eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0. expired")
    ).toBe("token [REDACTED:jwt] expired");
  });

  it("redacts a mongodb+srv:// userinfo credential", () => {
    // The `+`-bearing scheme the 16-char scheme cap was sized around — no other
    // URL fixture exercises the `+` in the scheme character class.
    expect(
      redactSecrets("dial mongodb+srv://svc:pw123456@cluster0.example.net/db")
    ).toBe(
      "dial mongodb+srv://[REDACTED:url_credentials]@cluster0.example.net/db"
    );
  });

  it("redacts a Databricks dapi<32 hex> token whole", () => {
    expect(redactSecrets(`dapi${HEX32}`)).toBe("[REDACTED:databricks]");
    // `{32,}` and not `{32}`: a longer run must be consumed whole rather than
    // leaving its overflow digits beside the marker.
    expect(redactSecrets(`dapi${HEX32}abcd`)).toBe("[REDACTED:databricks]");
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

  // Each fixture below carries a REAL secret whose redaction is also asserted.
  // That is load-bearing, not decoration: without one the string has no
  // `SECRET_PRETEST` anchor at all, `redactSecrets` bails on line 1, and the
  // assertion would stay green even if the pattern it exists to constrain were
  // widened to match the prose.
  it("does not redact digit-free re_ snake_case identifiers", () => {
    // The telemetry twin's `re_[A-Za-z0-9]{10,}` matches every one of these.
    // This file's extra digit-and-uppercase requirement is what keeps a
    // transcript preview from showing the user `[REDACTED:resend]` where they
    // wrote prose.
    const out = redactSecrets(
      "AKIAIOSFODNN7EXAMPLE gates the re_evaluation step, then re_generation and re_submission"
    );
    expect(out).toBe(
      "[REDACTED:aws_akia] gates the re_evaluation step, then re_generation and re_submission"
    );
  });

  it("does not redact versioned re_ snake_case identifiers", () => {
    // ISS-6799 review: a digit ALONE is satisfied by the ordinary `_v2` /
    // `step2` / `_2026` suffix an identifier carries, so the digit floor on its
    // own replaced all three of these wholesale — the same "UI lying about the
    // user's own words" failure that floor exists to prevent, one `_v2` further
    // along. The uppercase half of the guard is what declines them.
    const out = redactSecrets(
      "AKIAIOSFODNN7EXAMPLE ran re_generation_v2, then re_evaluation_step2 and re_submission_2026"
    );
    expect(out).toBe(
      "[REDACTED:aws_akia] ran re_generation_v2, then re_evaluation_step2 and re_submission_2026"
    );
  });

  it("redacts an issued key sitting beside versioned re_ prose", () => {
    // The discriminating case, and the one that stops the two assertions above
    // from being satisfiable by a blanket decline of everything `re_`-prefixed:
    // one string carrying both shapes, where the marker must appear at exactly
    // one of them. No separate pretest anchor is needed — the key is one.
    const out = redactSecrets(
      "re_generation_v2 authenticated with re_Ci3boZv4_JQZgKbF8xN2Yh7pQrTvWxYz"
    );
    expect(out).toBe("re_generation_v2 authenticated with [REDACTED:resend]");
  });

  it("does not redact npm_-prefixed environment variables", () => {
    const out = redactSecrets(
      "AKIAIOSFODNN7EXAMPLE with npm_package_devDependencies_typescript and npm_config_userconfig set"
    );
    expect(out).toBe(
      "[REDACTED:aws_akia] with npm_package_devDependencies_typescript and npm_config_userconfig set"
    );
  });

  it("does not redact a doubled slash after a URL version segment", () => {
    const out = redactSecrets(
      "AKIAIOSFODNN7EXAMPLE requested GET /v1//items-abcdefghijklmnopqrstuvwxyz"
    );
    expect(out).toBe(
      "[REDACTED:aws_akia] requested GET /v1//items-abcdefghijklmnopqrstuvwxyz"
    );
  });

  it("does not redact a body ONE character short of each new floor", () => {
    // Brackets every new minimum rather than merely clearing it: each body is
    // exactly one char under, so loosening a floor by one — the realistic
    // mutation, not zeroing it — turns this red. Bodies, in order: ya29. 9 of
    // 10, 1// 19 of 20, glpat- 19 of 20, npm_ 19 of 20, re_ 19 of the digit-free
    // alternative's 20, re_ 9 of the digit-bearing alternative's 10.
    const out = redactSecrets(
      "AKIAIOSFODNN7EXAMPLE ya29.abcdefghi 1//abcdefghijklmnopqrs glpat-abcdefghijklmnopqrs npm_abcdefghijklmnopqrs re_abcdefghijklmnopqrs re_abc12345f"
    );
    expect(out).toBe(
      "[REDACTED:aws_akia] ya29.abcdefghi 1//abcdefghijklmnopqrs glpat-abcdefghijklmnopqrs npm_abcdefghijklmnopqrs re_abcdefghijklmnopqrs re_abc12345f"
    );
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

  it("is idempotent over every marker the new families emit", () => {
    // A marker whose own text matches a pattern would corrupt output on the
    // second pass — `[REDACTED:npm_token]` carries an `npm_` substring, which
    // is why that label is bare `npm`.
    const once = redactSecrets(
      `ya29.${A32} 1//${A32} glpat-${A32} npm_${A32} re_${A32}`
    );
    expect(once).toBe(
      "[REDACTED:google_oauth_token] [REDACTED:google_refresh_token] [REDACTED:gitlab_pat] [REDACTED:npm] [REDACTED:resend]"
    );
    expect(redactSecrets(once)).toBe(once);
  });

  // ISS-6993 negatives. `redactSecrets` bails on line 1 when SECRET_PRETEST does
  // not fire, so a fixture with no anchor at all proves nothing about the rule
  // it names — it would stay green under a rule widened to match the prose. How
  // each of these defeats that early bail is stated on the case itself. Most are
  // SELF-anchoring, which is stronger than borrowing an unrelated secret: the
  // very substring under test is what forces the full pattern loop to run.
  it("does not redact an eyJ-prefixed base64 blob carrying no JWT separator", () => {
    // Self-anchoring: `eyJ` is itself a SECRET_PRETEST alternative, so the loop
    // runs and the two-segment requirement is what declines.
    const prose = `manifest ${EYJ_BLOB} decoded cleanly`;
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("redacts a real JWT sitting beside a separator-free eyJ blob", () => {
    // The discriminating case, and the one that stops the assertion above from
    // being satisfiable by a blanket decline of everything `eyJ`-prefixed: one
    // string carrying both shapes, where the marker must land on exactly one.
    const out = redactSecrets(`${EYJ_BLOB} then ${JWT}`);
    expect(out).toBe(`${EYJ_BLOB} then [REDACTED:jwt]`);
  });

  it("does not redact a PEM block that is a public certificate", () => {
    // Self-anchoring: `-----BEGIN` is itself a pretest alternative. `PRIVATE KEY`
    // is literal in the rule, and this is the fixture that proves it — drop it
    // and every certificate, CSR, and public key in a transcript is blanked.
    const prose =
      "-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKj34GkxFhD9\n-----END CERTIFICATE-----";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("does not redact a URL that carries a port but no credentials", () => {
    // Self-anchoring: `://localhost:` matches the `:\/\/[^\s\/@]*:` pretest
    // alternative, so the loop runs. The missing `@` terminator is what declines.
    const prose =
      "failed calling http://localhost:4318/v1/traces after 3 tries";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("does not redact a userinfo-shaped run sitting in a URL path or an ssh remote", () => {
    // NOT self-anchoring — neither `https://api.test/user:pass@…` nor
    // `ssh://git@…` reaches a `:` inside the authority, so neither trips the
    // pretest. The AWS key is carried expressly to defeat the early bail, and
    // its own redaction is asserted so the fixture cannot silently stop
    // anchoring.
    const out = redactSecrets(
      "AKIAIOSFODNN7EXAMPLE fetched https://api.test/user:pass@example.com/a via ssh://git@github.com/org/repo"
    );
    expect(out).toBe(
      "[REDACTED:aws_akia] fetched https://api.test/user:pass@example.com/a via ssh://git@github.com/org/repo"
    );
  });

  it("does not redact vendor-prefixed snake_case identifiers", () => {
    // Self-anchoring: every one of these prefixes is its own pretest
    // alternative. The body classes are what decline — `hf_`, `gsk_`, and
    // `lin_api_` exclude `_` so they cannot reach their floor across a
    // separator, and `figd_`/`dapi` fall short on length.
    const prose =
      "hf_config_path, gsk_helper, figd_local, lin_api_stub, SG.AbCdEfGhIjKlMnOp, and dapi0123456789abcdef";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("does not redact a PGP block that is a public key", () => {
    // Self-anchoring: `-----BEGIN` is its own pretest alternative. `(?: BLOCK)?`
    // widened the label to reach PGP PRIVATE blocks; this is what proves it did
    // not reach PUBLIC ones on the way.
    const prose =
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQINBFtx3wgBEACy9dq5f3v2z8x\n-----END PGP PUBLIC KEY BLOCK-----";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("does not redact structural shapes ONE character short of their floors", () => {
    // Self-anchoring on `eyJ`, `SG.`, and `://…:` respectively. Brackets the
    // three floors the vendor-prefix case below does not reach: a JWT second
    // segment at 7 of 8, a SendGrid id segment at 15 of 16, and a URL scheme at
    // 17 of a permitted 16.
    const prose =
      "eyJhbGciOiJIUzI1NiJ9.abcdefg.signaturebytesgohere SG.abcdefghij12345.qRsTuVwXyZ0123456789abcdef abcdefghijklmnopq://user:pw@host/path";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("matches provider casing exactly, like every other family in this file", () => {
    // Not a new rule — the file's stated convention is that provider tokens are
    // matched "at their documented casing to avoid catching prose", and `ghp_`,
    // `npm_`, and `glpat-` have always behaved this way here. Pinned because the
    // telemetry twin compiles its whole alternation `i` and so does NOT, and
    // that asymmetry is universal across both sets rather than special to any
    // one family. Self-anchoring: the pretest is `i`, so the loop runs and the
    // case-sensitive rules are what decline.
    const prose = `HF_${A32} GSK_${A32} FIGD_${A32} LIN_API_${A32} DAPI${HEX32.toUpperCase()} sg.AbCdEfGhIjKlMnOp.${A32}`;
    expect(redactSecrets(prose)).toBe(prose);
    // Non-vacuous: the same bodies at documented casing DO redact, so the
    // assertion above cannot be satisfied by a rule that matches nothing.
    expect(redactSecrets(`hf_${A32}`)).toBe("[REDACTED:huggingface]");
  });

  it("does not redact a vendor body ONE character short of its floor", () => {
    // Brackets each new minimum rather than merely clearing it: loosening a
    // floor by one — the realistic mutation, not zeroing it — turns this red.
    // Bodies, in order: 19 of 20, 19 of 20, 19 of 20, 19 of 20, 31 hex of 32.
    const prose =
      "hf_abcdefghijklmnopqrs gsk_abcdefghijklmnopqrs figd_abcdefghijklmnopqrs lin_api_abcdefghijklmnopqrs dapi0123456789abcdef0123456789abcde";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("is idempotent over every marker the ISS-6993 families emit", () => {
    // Same contract as the ISS-6799 case above: a marker whose own text carries
    // a pattern anchor would corrupt the output on a second pass. The URL marker
    // is the interesting one — it does NOT decline on re-entry, it re-matches
    // `[REDACTED` as the user and `url_credentials]` as the password and rewrites
    // the identical bytes.
    const once = redactSecrets(
      `${JWT} https://u:p@host hf_${A32} gsk_${A32} SG.AbCdEfGhIjKlMnOp.${A32} dapi${HEX32} figd_${A32} lin_api_${A32} -----BEGIN EC PRIVATE KEY-----body-----END EC PRIVATE KEY-----`
    );
    expect(once).toBe(
      "[REDACTED:jwt] https://[REDACTED:url_credentials]@host [REDACTED:huggingface] [REDACTED:groq] [REDACTED:sendgrid] [REDACTED:databricks] [REDACTED:figma] [REDACTED:linear] [REDACTED:pem_private_key]"
    );
    expect(redactSecrets(once)).toBe(once);
  });

  it("returns text unchanged when the pretest fires but no pattern matches", () => {
    // `re_2a` clears SECRET_PRETEST's `re_` anchor but not the 10-char body
    // floor, so this drives the full pattern loop to a no-match — the branch a
    // fixture with no anchor at all never reaches.
    const prose = "bumped re_2a and glpat-x in the fixture";
    expect(redactSecrets(prose)).toBe(prose);
  });
});

describe("FEAT 019f881c: redactSecrets — authorization scheme capture group", () => {
  it("redacts a bare Authorization credential with no scheme word (scheme capture group undefined → '')", () => {
    // The Authorization regex has an optional group ([A-Za-z]+\s+)? for the scheme.
    // When the credential follows directly after "Authorization: " without a scheme
    // word like "Bearer" — i.e. "[A-Za-z]+\s+" cannot match — the group is
    // undefined at runtime, and the replace lambda coerces it via `scheme || ""`.
    // The output still redacts the credential.
    const out = redactSecrets(`Authorization: ${A32}${A32}`);
    expect(out).toBe("Authorization: [REDACTED:authorization]");
    expect(out).not.toContain(A32);
  });
});

/**
 * ISS-7627. One positive fixture per family, keyed by `SecretPatternLabel`.
 *
 * The `Record<SecretPatternLabel, …>` annotation is the load-bearing half:
 * adding a family to `SECRET_PATTERNS` without a fixture here fails `tsc`, and a
 * fixture for a family that no longer exists fails it too. That is what makes
 * the `SECRET_PRETEST` superset rule a check rather than a paragraph — before
 * this, a family could ship with no anchor, `redactSecrets` would bail before
 * the pattern loop, and nothing would notice.
 *
 * `redacted` is the WHOLE expected output, not a substring. A fixture asserted
 * only as "something got redacted" can be satisfied by a NEIGHBOURING family's
 * pattern, which would leave its own family inert and the test green.
 *
 * Every value is synthetic and shaped, not a live credential — the same rule the
 * fixtures at the top of this file follow.
 */
const SECRET_PATTERN_FIXTURES: Record<
  SecretPatternLabel,
  { readonly input: string; readonly redacted: string }
> = {
  pemPrivateKeyBlock: {
    input:
      "-----BEGIN RSA PRIVATE KEY----- MIIBOgIBAAJBAKj34GkxFhD90vcNLYLI -----END RSA PRIVATE KEY-----",
    redacted: "[REDACTED:pem_private_key]",
  },
  urlUserinfoCredential: {
    input: "postgres://svc_user:s3cr3tpw@db.example.com:5432/app",
    redacted: "postgres://[REDACTED:url_credentials]@db.example.com:5432/app",
  },
  stripeKey: { input: `sk_live_${A32}`, redacted: "[REDACTED:sk_live]" },
  stripeWebhookSecret: { input: `whsec_${A32}`, redacted: "[REDACTED:whsec]" },
  githubToken: { input: `ghp_${A32}0000`, redacted: "[REDACTED:ghp]" },
  githubFineGrainedPat: {
    input: `github_pat_${A32}_${A32}`,
    redacted: "[REDACTED:github_pat]",
  },
  awsAccessKeyId: {
    input: "AKIAIOSFODNN7EXAMPLE",
    redacted: "[REDACTED:aws_akia]",
  },
  googleApiKey: {
    input: `AIzaSyD${A32}`,
    redacted: "[REDACTED:google_api_key]",
  },
  slackToken: {
    input: "xoxb-1234567890-abcdef",
    redacted: "[REDACTED:slack_token]",
  },
  huggingFaceToken: { input: `hf_${A32}`, redacted: "[REDACTED:huggingface]" },
  groqKey: { input: `gsk_${A32}`, redacted: "[REDACTED:groq]" },
  sendGridKey: {
    input: "SG.aBcDeFgHiJkLmNoP.qRsTuVwXyZ0123456789abcdefghij",
    redacted: "[REDACTED:sendgrid]",
  },
  databricksToken: {
    input: `dapi${HEX32}`,
    redacted: "[REDACTED:databricks]",
  },
  figmaToken: { input: `figd_${A32}`, redacted: "[REDACTED:figma]" },
  linearApiKey: { input: `lin_api_${A32}`, redacted: "[REDACTED:linear]" },
  googleAccessToken: {
    input: `ya29.${A32}`,
    redacted: "[REDACTED:google_oauth_token]",
  },
  googleRefreshToken: {
    input: `1//${A32}`,
    redacted: "[REDACTED:google_refresh_token]",
  },
  gitlabPat: { input: `glpat-${A32}`, redacted: "[REDACTED:gitlab_pat]" },
  npmToken: { input: `npm_${A32}`, redacted: "[REDACTED:npm]" },
  resendKey: { input: `re_${A32}`, redacted: "[REDACTED:resend]" },
  anthropicKey: {
    input: `sk-ant-api03-${A32}${A32}`,
    redacted: "[REDACTED:sk-ant]",
  },
  openaiKey: {
    input: `sk-proj-${A32}${A32}`,
    redacted: "[REDACTED:sk-openai]",
  },
  openaiLegacyKey: { input: `sk-${A32}${A32}`, redacted: "[REDACTED:sk]" },
  authorizationHeader: {
    input: "Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1",
    redacted: "Authorization: Basic [REDACTED:authorization]",
  },
  bearerToken: {
    input: `Bearer ${A32}`,
    redacted: "Bearer [REDACTED:bearer]",
  },
  jwt: { input: JWT, redacted: "[REDACTED:jwt]" },
};

describe("ISS-7627: every SECRET_PATTERNS family is anchored AND fires", () => {
  it("declares each label on exactly one pattern, and each has a fixture", () => {
    // Guards the two holes the `Record` annotation cannot see: a union member no
    // entry declares (so `tsc` demands a fixture that runs against nothing), and
    // one label on two entries (so one of them inherits the other's fixture).
    expect([...SECRET_PATTERN_LABELS].sort()).toEqual(
      Object.keys(SECRET_PATTERN_FIXTURES).sort()
    );
  });

  for (const [label, { input, redacted }] of Object.entries(
    SECRET_PATTERN_FIXTURES
  )) {
    // Split deliberately. `redactSecrets` bails before the pattern loop when the
    // pretest misses, so a single combined assertion cannot tell "this family
    // has no anchor" from "this family's pattern is broken" — and those have
    // different fixes in different parts of the file.
    it(`${label}: SECRET_PRETEST anchors its fixture`, () => {
      expect(SECRET_PRETEST.test(input)).toBe(true);
    });

    it(`${label}: redactSecrets replaces its fixture whole`, () => {
      expect(redactSecrets(input)).toBe(redacted);
    });
  }
});
