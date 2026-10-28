/**
 * @file redact-secrets.ts
 * @description FEAT 019f881c-99f3 ([Security] Redact easily-identifiable secrets
 * in session transcripts). Single source of truth for pattern-based secret
 * redaction, shared by BOTH the desktop sync producer
 * (`apps/desktop/src/main/agent-sync/agent-session-sync-metadata.ts`
 * `compactSessionMetadataForSync`) and the server-side persist sanitizer
 * (`apps/api/app/agent-sessions/service/metadata-sanitizer.ts`
 * `sanitizeMetadataForPersist`).
 *
 * A live `sk_live_…` API key was rendered UNREDACTED in a session transcript.
 * The `metadata.messages[].text` preview is the DISPLAY source for the branch
 * merged trace and session-detail timeline (`agent-session-detail-projection.ts`
 * `metadataMessages()` → `messageToTimelineEvent` `detail`), and it is the one
 * place conversation text still crosses to the cloud DB and UI. Redacting here —
 * at the SAME normalization boundary that already length-caps that preview —
 * guarantees a recognizable secret never persists to server storage nor reaches
 * the UI, on both the desktop-capture and non-desktop (direct API / MCP / test
 * harness) lanes. Extracting the pattern list + redactor into this one module is
 * what keeps the two lanes from drifting.
 *
 * TWO secret vocabularies exist in this repo and they remain SEPARATE. This one
 * is the session-transcript set; `packages/loops-api/src/secret-value-pattern.ts`
 * is the telemetry set (Datadog intake, the log-drain JSON line, the desktop
 * exception path). ISS-6799 resolved the reconciliation question left open by
 * ISS-6233/ISS-6709 as follows: the five families that existed only in the
 * telemetry set — `ya29.`, `1//`, `glpat-`, `npm_`, `re_` — are ADDED here as
 * their own declarations (option 2 on the ticket), because they were reaching
 * the agent-coaching LLM seam unredacted. The sets were NOT merged: they front
 * different sinks with different over-redaction costs (a telemetry line is read
 * by an operator; a transcript preview is rendered back to the user who wrote
 * it), which is why this file's `re_` guard is shaped differently from the
 * telemetry twin's. Nothing enforces agreement between the two lists: adding a
 * family to either still means adding it to the other by hand, and that
 * enumeration is prose, not a guard.
 *
 * ISS-6992 then adjudicated the two differences ISS-6799 had recorded but not
 * decided, and the decision is stated here as well as at the telemetry list so
 * neither reader has to take the other file's word for it:
 *   - GitHub `ghr_`, which this file's `gh[pousr]_` carried and the telemetry
 *     twin's `gh[opsu]_` did not, was DRIFT. The body class collides with no
 *     prose, so the over-redaction argument that shapes `re_` below has no
 *     analogue; nothing here changes, and the telemetry twin is now
 *     `gh[oprsu]_`.
 *   - The telemetry `re_` body class, which could not cross an underscore and
 *     so missed a SEGMENTED key, was also DRIFT — that sink's pre-existing
 *     10-char base62 floor already matched `re_evaluation`-style prose, so it
 *     was never the side buying prose fidelity. The telemetry twin is now
 *     `re_[A-Za-z0-9_]{10,}`.
 * `re_` therefore still diverges, deliberately, but now in ONE direction only:
 * the extra digit-and-uppercase requirement below is this sink's alone, because
 * this is the sink whose output is rendered back to the user who wrote it. An
 * all-lowercase body between 10 and 19 chars is matched THERE and not HERE, on
 * purpose. See the long comment on the `re_` pattern for the reasoning.
 *
 * ISS-6993 added nine families to BOTH sets at once — bare `eyJ` JWTs, PEM
 * private-key blocks, `scheme://user:pass@` URL userinfo, and the `hf_`, `gsk_`,
 * `SG.`, `dapi`, `figd_`, `lin_api_` vendor prefixes — because they were in
 * NEITHER and so redacted nowhere. Eight of the nine came out with a
 * byte-identical SOURCE STRING on both sides, which is a finding rather than a
 * merge: the ownership question was asked per class and no per-sink cost
 * difference was found for any of them. Every one either excludes `_` from its
 * body class or demands a multi-segment shape, so none can bite a snake_case
 * identifier the way an unguarded `re_` would, and there was nothing to trade
 * away on either side. The ninth, `urlUserinfoCredential`, captures the scheme
 * HERE so the host and path survive; the telemetry consumers replace the whole
 * match, so that side needs no capture. The two sets remain separate declarations.
 *
 * FLAGS ARE NOT PART OF THAT EQUIVALENCE, and the difference is universal rather
 * than per-family. Every pattern in this file is case-SENSITIVE, per the
 * documented-casing convention stated below; the telemetry file compiles its
 * whole alternation with `i`, so it also matches casings no provider issues.
 * That has always been true of `ghp_`, `npm_`, and `glpat-` here just as much as
 * of the families ISS-6993 added — do not read an identical source string as
 * identical behaviour on a mixed-case input.
 *
 * That enumeration is prose, but it is no longer the only thing holding the two
 * sets together: `apps/desktop/test/secret-vocabulary-agreement.test.ts`
 * (ISS-6992) fails when a telemetry family has neither a byte-identical twin
 * here nor a recorded reason for differing — the guard the `ghr_` and segmented
 * `re_` drifts slipped past. Adding a family to either set still means adding it
 * to the other by hand; the guard tells you when you forgot.
 *
 * Boundary: this redacts the strings its CALLERS hand it — the sync/persist
 * metadata preview, the redacted JSONL upload stream, the desktop coaching
 * payload, and agent-component definition text on the invocation and inventory
 * sync lanes (ISS-4965). It does NOT reach the raw sources those are derived
 * from: the agent's own transcript files on local disk, the desktop SQLite
 * `event` rows, and the desktop's own definition files and component rows still
 * hold whatever was written. A clean output here means the
 * derived sink is clean, not that the credential was never captured.
 *
 * Design constraints:
 * - Redact by matching real secret PREFIXES/SHAPES + a length/entropy guard, so
 *   ordinary prose (any word with an underscore, a short `sk-` fragment, a bare
 *   `Bearer` with no token) is never touched. See `redactSecrets` guards.
 * - Replace each secret span with a stable, byte-free marker of the form
 *   `[REDACTED:<label>]` (e.g. `[REDACTED:sk_live]`). The marker preserves the
 *   KIND of secret so a redaction is recognizable without leaking any bytes.
 * - Browser-safe (no `node:*` / `Buffer` / `process`) so it typechecks under the
 *   `@repo/lib` `types: []` guard and runs identically on desktop and cloud.
 * - Hot sync path: all patterns are module-level pre-compiled regexes and
 *   `redactSecrets` is a single `String.prototype.replace` pass per pattern with
 *   no allocation when the input is clean (early `SECRET_PRETEST` bail).
 */

/** Redaction marker for a secret of the given label — no secret bytes leak. */
function marker(label: string): string {
  return `${REDACTION_MARKER_PREFIX}${label}]`;
}

/**
 * Whether a PEM match ended on a real `-----END … PRIVATE KEY-----` footer, as
 * opposed to running out of visible body. Declared beside `marker` rather than
 * inline because Ultracite's `useTopLevelRegex` forbids a literal inside a
 * function, and because the PEM rule below is the only caller.
 */
const PEM_TERMINATED_PATTERN =
  /-----END(?:[A-Z ]+)?PRIVATE KEY(?: BLOCK)?-----$/;

/**
 * ISS-7627. The families this file redacts, one member per `SECRET_PATTERNS`
 * entry. It exists so the test's fixture table can be a
 * `Record<SecretPatternLabel, …>`: adding a family without a fixture then fails
 * `tsc`, which is what turns the `SECRET_PRETEST` superset rule below from a
 * docstring into a check. Names match the telemetry twin's
 * `SecretValueFamily` where the family is the same — the two vocabularies stay
 * separate declarations (ISS-6994 is still open), but agreeing on the WORD for
 * a family costs nothing and makes that ruling cheaper to carry out either way.
 *
 * A label is NOT the marker text. `stripeKey` and `githubToken` derive their
 * marker from the match, and `pemPrivateKeyBlock` emits one of two depending on
 * whether a footer was found, so the two vocabularies cannot be collapsed.
 */
export type SecretPatternLabel =
  | "pemPrivateKeyBlock"
  | "urlUserinfoCredential"
  | "stripeKey"
  | "stripeWebhookSecret"
  | "githubToken"
  | "githubFineGrainedPat"
  | "awsAccessKeyId"
  | "googleApiKey"
  | "slackToken"
  | "huggingFaceToken"
  | "groqKey"
  | "sendGridKey"
  | "databricksToken"
  | "figmaToken"
  | "linearApiKey"
  | "googleAccessToken"
  | "googleRefreshToken"
  | "gitlabPat"
  | "npmToken"
  | "resendKey"
  | "anthropicKey"
  | "openaiKey"
  | "openaiLegacyKey"
  | "authorizationHeader"
  | "bearerToken"
  | "jwt";

type SecretPattern = {
  /**
   * Which family this entry recognizes. Unique across `SECRET_PATTERNS` — the
   * test asserts that, because a duplicated label would let one family inherit
   * another's fixture and go untested.
   */
  readonly label: SecretPatternLabel;
  /** Compiled matcher. MUST be global (`g`) for `replace`-all semantics. */
  readonly regex: RegExp;
  /**
   * Produce the replacement for a single match. Receives the full match and any
   * capture groups so a pattern can preserve a non-secret prefix (e.g. keep the
   * `Authorization:` header name, redact only its value).
   */
  readonly replace: (match: string, ...groups: string[]) => string;
};

/**
 * The `[a-z]` in `sk-`/`sk_` etc. is intentionally case-INSENSITIVE only where
 * the real token grammar allows it; provider tokens (`sk_live_`, `ghp_`, `AKIA`)
 * are matched at their documented casing to avoid catching prose. Character
 * classes use the base64url / token alphabet the providers actually emit.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // ISS-6993. PEM private-key block, placed first because it is the only rule
  // whose match spans other rules' territory and reading it first is clearest.
  //
  // Its position is NOT load-bearing, and saying so is deliberate: a body
  // carrying another family's shape produces the identical output either way,
  // because this rule's `[\s\S]*?` re-consumes whatever marker ran before it.
  // Do not add a test claiming a reorder would be caught here — it would not be,
  // and the test would pass under the mutation it names.
  //
  // Most callers hand this a LENGTH-CAPPED string (the metadata preview, a
  // JSONL line, a coaching payload, a definition body an older Desktop already
  // clamped), so a header whose footer was cut off is the
  // expected shape rather than the exotic one, and everything following a
  // `PRIVATE KEY` header is key material. Hence the second alternative.
  //
  // It is NOT `$`. In JavaScript `$` without `m` asserts the true end of input
  // and nothing else — not the position before a trailing newline — so an
  // unterminated block consumed the line terminator too. `redacted-jsonl-transcript`
  // hands this each line with its `\n` still attached, so that silently merged a
  // record with the one after it. The fallback instead takes the rest of the
  // header's own line plus any following WHOLE base64 lines: a multi-line
  // truncated body is still consumed, prose on a later line is not, and the `\n`
  // survives. A record whose key material ran to its own end still cannot be
  // closed — there is nothing left to close it with — but it no longer takes the
  // next record with it.
  //
  // `(?: BLOCK)?` is load-bearing: OpenPGP's armor label is
  // `PGP PRIVATE KEY BLOCK-----`, so the literal `PRIVATE KEY-----` never occurs
  // in it, and without this a `gpg --export-secret-keys --armor` dump — the
  // ordinary way a human moves a private key — matched NOTHING here or at the
  // telemetry twin. `PGP PUBLIC KEY BLOCK` still declines; `PRIVATE` is literal.
  //
  // The two terminators get DIFFERENT markers. A reader has to be able to tell
  // "a complete block was found and replaced" from "a header was found, no
  // footer existed, and everything to the end of the visible body was consumed"
  // — the second says the surrounding text may be missing on purpose. Same
  // reasoning as `exception-sanitizer`'s `[redacted]` vs `[redacted-overlong]`.
  {
    label: "pemPrivateKeyBlock",
    regex:
      /-----BEGIN(?:[A-Z ]+)?PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END(?:[A-Z ]+)?PRIVATE KEY(?: BLOCK)?-----|[^\n]*(?:\n[A-Za-z0-9+/=]+(?=\n|$))*)/g,
    replace: (match) =>
      marker(
        PEM_TERMINATED_PATTERN.test(match)
          ? "pem_private_key"
          : "pem_private_key_unterminated"
      ),
  },
  // ISS-6993. URL userinfo: `scheme://user:pass@host`. Only the userinfo run is
  // replaced — the scheme is captured and re-emitted and the `@` is put back —
  // so the host and path survive and a connection failure stays diagnosable,
  // the same bargain the `Authorization:` pattern below strikes with its header
  // name.
  //
  // The user half is optional-width (`redis://:pw@host` is a real shape) but the
  // password half is not, so `https://host:8080/path` cannot match: its `:` run
  // has no `@` terminator before the authority ends. Case-insensitive because
  // RFC 3986 schemes are, and the scheme run is capped at 16 characters
  // (`mongodb+srv` is 11) so a long dotted lowercase string cannot hand the
  // engine one unbounded scan per offset.
  //
  // Both classes stop at `?` and `#` as well as `/`, because all three end the
  // authority (RFC 3986 3.2) and none may appear unencoded in userinfo. Without
  // that, `http://localhost:4318?email=user@example.com` matched — the port
  // colon standing in for the user/password separator and the run scanning past
  // the `?` — and this sink rewrote a credential-free diagnostic to
  // `http://[REDACTED:url_credentials]@example.com`, losing the port and the
  // whole query (codex review of PR #5339).
  //
  // Idempotent by construction of the marker, not by luck of a decline: a second
  // pass re-matches `[REDACTED` as the user and `url_credentials]` as the
  // password and rewrites the identical bytes.
  {
    label: "urlUserinfoCredential",
    regex: /\b([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/:@?#]*:[^\s/@?#]+@/gi,
    replace: (_match, scheme: string) =>
      `${scheme}${marker("url_credentials")}@`,
  },
  // Stripe-style keyed secrets: sk_live_, sk_test_, rk_live_, pk_live_,
  // pk_test_. `pk_` publishable keys are technically public, but the AC lists
  // pk_live_ and redacting them is harmless. Require >= 8 chars of key body so
  // `pk_test_` alone in prose (rare) still needs a real-looking body to match.
  // The captured `<prefix>_<live|test>` becomes the label (e.g. `sk_live`).
  {
    label: "stripeKey",
    regex: /\b((?:sk|rk|pk)_(?:live|test))_[A-Za-z0-9]{8,}/g,
    replace: (_match, label: string) => marker(label),
  },
  // Stripe webhook signing secret: whsec_<body>. Single-underscore prefix, so
  // it is matched separately from the two-underscore keyed secrets above.
  {
    label: "stripeWebhookSecret",
    regex: /\bwhsec_[A-Za-z0-9]{8,}/g,
    replace: () => marker("whsec"),
  },
  // GitHub tokens: ghp_ (PAT), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server-to-server), ghr_ (refresh). 36+ base62 chars in the real
  // format; require >= 20 to stay well clear of prose while tolerating variants.
  {
    label: "githubToken",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replace: (match) => marker(match.slice(0, 3)),
  },
  // GitHub fine-grained PAT: github_pat_<22>_<59>.
  {
    label: "githubFineGrainedPat",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replace: () => marker("github_pat"),
  },
  // AWS access key id: AKIA / ASIA + 16 uppercase-alphanumeric.
  {
    label: "awsAccessKeyId",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: () => marker("aws_akia"),
  },
  // Google API key: AIza + 35 url-safe chars.
  {
    label: "googleApiKey",
    regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    replace: () => marker("google_api_key"),
  },
  // Slack token: xox[baprs]-<digits/hex ...>.
  {
    label: "slackToken",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => marker("slack_token"),
  },
  // ISS-6993 vendor prefixes. These were in NEITHER vocabulary, so they were
  // redacted nowhere. Each is declared at the SAME shape as its telemetry twin
  // because the ownership question was asked per class and no per-sink cost
  // difference was found: every body class below either excludes `_` (`hf_`,
  // `gsk_`, `lin_api_`) or demands a shape no identifier reaches (`figd_`'s
  // 20-char floor, `dapi`'s 32 hex digits, `SG.`'s two segments), so unlike
  // `re_` none of them can bite a snake_case word in a transcript preview.
  //
  // Hugging Face user access token: hf_<34 base62>.
  {
    label: "huggingFaceToken",
    regex: /\bhf_[A-Za-z0-9]{20,}/g,
    replace: () => marker("huggingface"),
  },
  // Groq API key: gsk_<52 base62>.
  {
    label: "groqKey",
    regex: /\bgsk_[A-Za-z0-9]{20,}/g,
    replace: () => marker("groq"),
  },
  // SendGrid API key: SG.<id>.<secret>. Case-SENSITIVE, like every pattern in
  // this file and unlike the telemetry twin — see the header; that asymmetry is
  // file-wide, not a judgement about SendGrid. Worth naming HERE only because
  // `SG.` is the one new family whose documented casing is uppercase, so it is
  // the one where a reader is most likely to wonder.
  {
    label: "sendGridKey",
    regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    replace: () => marker("sendgrid"),
  },
  // Databricks PAT: dapi<32 hex>. `{32,}` and not `{32}` so a longer run is
  // still consumed WHOLE; a fixed count would leave the overflow digits sitting
  // beside the marker as a fragment of the token.
  {
    label: "databricksToken",
    regex: /\bdapi[a-fA-F0-9]{32,}/g,
    replace: () => marker("databricks"),
  },
  // Figma personal access token: figd_<40+ url-safe>.
  {
    label: "figmaToken",
    regex: /\bfigd_[A-Za-z0-9_-]{20,}/g,
    replace: () => marker("figma"),
  },
  // Linear API key: lin_api_<40 base62>.
  {
    label: "linearApiKey",
    regex: /\blin_api_[A-Za-z0-9]{20,}/g,
    replace: () => marker("linear"),
  },
  // ISS-6799: the five families below had lived ONLY in the telemetry
  // vocabulary, so they reached the agent-coaching LLM seam — pluggable, and by
  // its own header possibly an EXTERNAL provider — in clear. They are DECLARED
  // here rather than imported from that module on purpose (see this file's
  // header): the two vocabularies stay separate, so this is sanctioned
  // duplication, not drift.
  //
  // Google OAuth access token: ya29.<body>. Not covered by the Bearer/
  // Authorization forms below — googleapis error text quotes the offending
  // credential bare, with no scheme word in front of it.
  {
    label: "googleAccessToken",
    regex: /\bya29\.[A-Za-z0-9._~+-]{10,}/g,
    replace: () => marker("google_oauth_token"),
  },
  // Google OAuth refresh token: 1//<body>. The leading `1` must sit on a word
  // boundary, so a doubled slash after a version segment (`/v1//items`) cannot
  // match — the `1` there is preceded by `v`.
  {
    label: "googleRefreshToken",
    regex: /\b1\/\/[A-Za-z0-9._~+-]{20,}/g,
    replace: () => marker("google_refresh_token"),
  },
  // GitLab personal access token: glpat-<20+>.
  {
    label: "gitlabPat",
    regex: /\bglpat-[A-Za-z0-9_-]{20,}/g,
    replace: () => marker("gitlab_pat"),
  },
  // npm automation/publish token: npm_<20+ base62>. The body class excludes
  // `_`, so `npm_config_registry` and friends never reach the 20-char floor.
  // The label is bare `npm` and not `npm_token` on purpose: the marker text is
  // itself re-scanned on an idempotent re-run, and `[REDACTED:npm_token]` would
  // carry an `npm_` substring that defeats SECRET_PRETEST's early bail.
  {
    label: "npmToken",
    regex: /\bnpm_[A-Za-z0-9]{20,}/g,
    replace: () => marker("npm"),
  },
  // Resend API key: re_<body>. The telemetry twin's single floor (10 base62
  // chars) is deliberately NOT reused verbatim here: on this sink the redacted
  // text is rendered back to the user in a transcript preview, and
  // `re_evaluation`, `re_generation`, and `re_submission` all clear a bare
  // 10-char floor — that false positive is the UI lying about the user's own
  // words. Two alternatives instead, so declining the prose match costs as
  // little coverage as possible:
  //   1. a body carrying BOTH a digit and an uppercase letter (>= 10 chars, `_`
  //      allowed, so a segmented `re_<seg>_<seg>` key satisfies either class in
  //      EITHER segment) — the entropy half of this file's stated guard, which
  //      an issued base62 key satisfies and a snake_case identifier does not; or
  //   2. failing that, >= 20 unbroken base62 chars, which catches an
  //      all-letters key body and which no plausible `re_`-prefixed identifier
  //      reaches (`re_characterization` is 16, `re_synchronization` is 15).
  //
  // The uppercase half of alternative 1 is load-bearing, not belt-and-braces: a
  // digit alone is satisfied by the ordinary version suffix that snake_case
  // identifiers carry, so `re_generation_v2`, `re_evaluation_step2`, and
  // `re_submission_2026` were all being replaced wholesale — the same "UI lying
  // about the user's own words" failure the digit floor was added to prevent,
  // just one `_v2` further along. Requiring a character class that lowercase
  // prose does not produce declines that family without touching an issued key,
  // whose base62 body is mixed-case with overwhelming likelihood.
  //
  // Residual, and stated rather than hidden: a key whose body is entirely
  // lowercase-and-digits AND stays under 20 unbroken chars escapes this sink
  // (as does one that is BOTH digit-free and segmented below 20 per segment).
  // For a randomly issued base62 body the all-lowercase case is ~(36/62)^10,
  // under 1% at the 10-char floor and falling from there. Still not zero.
  {
    label: "resendKey",
    regex:
      /\bre_(?:(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9_]{10,}|[A-Za-z0-9]{20,})/g,
    replace: () => marker("resend"),
  },
  // Anthropic + OpenAI long high-entropy API keys: sk-ant-… and sk-…. Anchor
  // the sk-ant- variant first so its more specific label wins. Require a long,
  // high-entropy body (>= 32 token chars) so a short `sk-foo` in prose or a
  // kebab-case identifier like `sk-config-value` is NOT redacted.
  {
    label: "anthropicKey",
    regex: /\bsk-ant-[A-Za-z0-9_-]{32,}/g,
    replace: () => marker("sk-ant"),
  },
  {
    label: "openaiKey",
    regex: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}/g,
    replace: () => marker("sk-openai"),
  },
  {
    label: "openaiLegacyKey",
    regex: /\bsk-[A-Za-z0-9]{32,}/g,
    replace: () => marker("sk"),
  },
  // Bearer <token> and `Authorization: <scheme> <token>` header values. Keep the
  // header name / scheme, redact only the credential. Require a real token body
  // (>= 16 non-space chars) so a bare "Bearer" or "Authorization:" with no
  // credential — or a sentence like "the Authorization: pending" — is left as
  // prose. Case-insensitive on the scheme word only.
  {
    label: "authorizationHeader",
    regex: /\b(Authorization\s*:\s*)([A-Za-z]+\s+)?([A-Za-z0-9._~+/=-]{16,})/gi,
    // `scheme` is an optional capture group — it is `undefined` at runtime when
    // the header carries a bare credential with no scheme word. The `replace`
    // contract types it `string`, so coerce with `|| ""`.
    replace: (_match, header: string, scheme: string) =>
      `${header}${scheme || ""}${marker("authorization")}`,
  },
  {
    label: "bearerToken",
    // Case-insensitive on the scheme word (`Bearer` / `bearer`) — HTTP header
    // dumps and curl `-H` args commonly emit it lowercase, and the standalone
    // `Bearer <token>` form must redact regardless of casing (the
    // `Authorization:` pattern above is already `i` for the same reason). The
    // captured scheme keeps its ORIGINAL casing in the output.
    regex: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (_match, scheme: string) => `${scheme}${marker("bearer")}`,
  },
  // ISS-6993. A BARE JWT — `eyJ…` with no `Bearer` prefix and no
  // `Authorization:` header name in front of it. That is the gap: the two
  // patterns above already cover the prefixed forms, and this is what an expired
  // -token error, a decoded-payload paste, or a `?access_token=` query string
  // actually looks like in a transcript.
  //
  // LAST in this array on purpose. The prefixed forms must win where both could
  // match, so `Bearer eyJ….….…` keeps its `[REDACTED:bearer]` label and the
  // scheme word it preserves, rather than being relabelled by this rule.
  //
  // Two base64url segments joined by a `.` is the entire discriminator, and it
  // is load-bearing: an `eyJ`-prefixed blob with no separator is ordinary
  // base64-encoded JSON, which this repo itself ships (the desktop docs bundle
  // manifest).
  //
  // The trailing `{0,3}` covers a 3-segment JWS, an `alg: none` JWS whose
  // signature segment is empty, and a 5-segment compact JWE — without it a JWE's
  // `iv`, `ciphertext`, and `tag` were left sitting in clear immediately after
  // the marker. Allowing EMPTY trailing segments widens only how far right a
  // match extends, never whether one starts (the entry condition is still two
  // non-empty segments), so it adds no false positive. Residual, stated rather
  // than hidden: a `dir`-algorithm JWE whose encrypted-key segment is empty
  // fails the second `{8,}` and is not matched.
  {
    label: "jwt",
    regex:
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,3}/g,
    replace: () => marker("jwt"),
  },
];

/**
 * The compiled source of every pattern above, in order.
 *
 * Exported for `redact-secrets-vocabulary-agreement.test.ts` and nothing else.
 * The two secret vocabularies stay separate declarations by design, but ISS-6992
 * was caused by two of them silently disagreeing while a prose enumeration
 * claimed they matched — so the subset that IS claimed byte-equivalent is pinned
 * mechanically rather than by comment.
 */
export const SECRET_PATTERN_SOURCES: readonly string[] = SECRET_PATTERNS.map(
  (pattern) => pattern.regex.source
);

/**
 * The label of every pattern above, in order.
 *
 * ISS-7627. Exported for `redact-secrets.test.ts` and nothing else. The
 * `Record<SecretPatternLabel, …>` fixture table there is what `tsc` checks; this
 * is what closes the two holes `tsc` cannot see — a union member no entry
 * actually declares, and one label declared by two entries — either of which
 * would let a family carry a fixture it never runs.
 */
export const SECRET_PATTERN_LABELS: readonly SecretPatternLabel[] =
  SECRET_PATTERNS.map((pattern) => pattern.label);

/**
 * Cheap pre-test: a single combined regex of the cheapest anchors. When it does
 * NOT match, the input has no secret-shaped substring and we return it
 * unchanged without running the full pattern loop — keeping the hot sync path
 * allocation-free for the overwhelmingly common clean message.
 *
 * Every alternative here MUST be a superset of the anchor of the pattern it
 * stands in for — a pretest narrower than its pattern is a silent bypass, not a
 * missed optimization, because the bail returns the input untouched.
 *
 * ISS-7627: that rule is no longer only this paragraph. It is exported for
 * `redact-secrets.test.ts` and nothing else, where a
 * `Record<SecretPatternLabel, …>` fixture table asserts per family that this
 * pretest matches the family's fixture — so a new family whose anchor never
 * lands here fails a test rather than shipping silently inert, and a family
 * declared with no fixture at all fails `tsc`. The two assertions are kept
 * separate on purpose: `redactSecrets` alone cannot tell "the pretest bailed"
 * from "the pattern did not fire", and those have different fixes.
 *
 * ISS-6993: a class added to `SECRET_PATTERNS` without a matching anchor here is
 * not merely un-optimized, it is a full pattern scan on every forwarded string
 * on this sink — the bail is what keeps the hot path cheap, and a class that
 * cannot bail costs the whole loop. So each of the nine new classes brings its
 * own alternative. All nine are supersets:
 *   - `eyJ` is the JWT pattern's own literal prefix;
 *   - `-----BEGIN` is the PEM pattern's own literal prefix;
 *   - `:\/\/[^\s\/@]*:` widens the URL pattern's user class (`[^\s\/:@?#]*`) by
 *     three characters, so anything the pattern matches this reaches too. It
 *     stayed deliberately wide when PR #5339's review narrowed the pattern to
 *     stop at `?` and `#`: narrowing a pattern only strengthens the superset
 *     relation, and narrowing the pretest alongside it would buy nothing while
 *     putting the bail one edit from becoming a silent bypass;
 *   - the six vendor prefixes are their patterns' literal prefixes, and the `i`
 *     flag makes them supersets of the two (`SG.`, `dapi`) whose patterns are
 *     case-sensitive.
 * `:\/\/…:` is the one alternative here that is not a bare prefix. A bare `://`
 * would fire on every URL in a transcript, which is most of them; requiring the
 * authority to also carry a `:` narrows it to a host:port or a credential
 * without giving up the superset property.
 */
export const SECRET_PRETEST =
  /(?:sk|rk|pk)_(?:live|test)_|whsec_|gh[pousr]_|github_pat_|AKIA|ASIA|AIza|xox[baprs]-|ya29\.|1\/\/|glpat-|npm_|re_[A-Za-z0-9_]|sk-[A-Za-z0-9]|Bearer\s|Authorization\s*:|eyJ|-----BEGIN|:\/\/[^\s/@]*:|hf_|gsk_|SG\.|dapi|figd_|lin_api_/i;

/**
 * Redact recognizable secrets from a single string, replacing each with a
 * shape-preserving `[REDACTED:<label>]` marker. Returns the input unchanged when
 * it contains no secret-shaped substring (the common case). Non-string / empty
 * input is returned as-is. Idempotent: re-running over already-redacted text is a
 * no-op (markers contain no secret-shaped substrings).
 */
export function redactSecrets(value: string): string {
  if (!(value && SECRET_PRETEST.test(value))) {
    return value;
  }
  let out = value;
  for (const { regex, replace } of SECRET_PATTERNS) {
    // regex is stateful (global flag) — reset before reuse across calls.
    regex.lastIndex = 0;
    out = out.replace(
      regex,
      replace as (substring: string, ...args: unknown[]) => string
    );
  }
  return out;
}

/** The fixed head of every marker {@link redactSecrets} writes. */
export const REDACTION_MARKER_PREFIX = "[REDACTED:";
