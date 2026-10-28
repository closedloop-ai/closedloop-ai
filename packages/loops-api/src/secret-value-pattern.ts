/**
 * The canonical answer to "what does a leaked credential look like?" for the
 * TELEMETRY redaction paths — those that scrub secret-shaped tokens out of free
 * text on its way to a diagnostic sink. Do not re-declare this alternation in a
 * consumer; derive from it (ISS-6233). Consumers today:
 *   - `@repo/observability/redact` — `redactSensitiveText`, which feeds the
 *     agentless Datadog HTTP intake body and the structured-console JSON line
 *     the platform log drain parses into facets.
 *   - `apps/desktop/src/shared/exception-sanitizer` — the desktop exception
 *     path (main + renderer), which blanks a whole field on a match because
 *     what follows a secret marker is unbounded and unparseable.
 *   - `apps/desktop/src/main/collectors/engine/historical-parse-worker-diagnostics`
 *     (ISS-6898) — the historical-parse worker's stderr/diagnostic sink, which
 *     substitutes in place so the surrounding stderr stays diagnosable. It was
 *     an independent hand-rolled copy until ISS-6898 and had drifted seven families
 *     behind. It keeps ONE local rule, `AKIA`/`ASIA`/`AROA`, precisely because
 *     this set deliberately does not carry AWS (see the paragraph below): that
 *     is coverage this set cannot supply, not a re-declaration of one it can.
 *
 * NOT the whole repo's secret vocabulary. `packages/lib/security/redact-secrets`
 * is a separate redactor for a different sink (session-transcript metadata
 * crossing to the cloud DB and UI) with its own labelled `[REDACTED:<label>]`
 * markers and a deliberately different family set. As of ISS-6233 it carries
 * AWS `AKIA`/`ASIA`, Google `AIza`, Stripe `whsec_`, Stripe `rk_`/`pk_`, and the
 * bare `Authorization: <credential>` header form — none of which this set
 * matches.
 *
 * ISS-6799 closed the other direction: `ya29.`, `1//`, `glpat-`, `npm_`, and
 * `re_` used to live only here, and the transcript set now declares its own
 * copies of all five. The two sets were NOT merged — they front different sinks
 * with different over-redaction costs — and four of the five shapes are
 * byte-equivalent.
 *
 * ISS-6992 adjudicated the two remaining differences that ISS-6799 recorded but
 * did not decide. Both were DRIFT, not per-sink judgement, and both are closed
 * here; the reasoning is stated at both pattern lists per that ticket:
 *   - GitHub `ghr_`. This file's `githubToken` read `gh[opsu]_` while the
 *     transcript twin reads `gh[pousr]_`, so a GitHub OAuth REFRESH token was
 *     redacted in a transcript preview and shipped to the Datadog intake, the
 *     log-drain line, and the desktop exception path in clear. No per-sink cost
 *     justifies that: the body class `[A-Za-z0-9_]{20,}` collides with no prose,
 *     so the over-redaction argument that legitimately shapes `re_` below has no
 *     analogue here — an alphabetised `[opsu]` beside a documentation-ordered
 *     `[pousr]` is an un-reconciled copy that lost a member. Now `gh[oprsu]_`.
 *   - Resend `re_`. `resendKey`'s body class was `[A-Za-z0-9]`, which cannot
 *     cross an underscore, so a SEGMENTED key (`re_<seg>_<seg>`) whose first
 *     segment is under 10 chars was not matched HERE and reached all three
 *     telemetry sinks in clear. Widening the body to `[A-Za-z0-9_]` costs this
 *     sink nothing it had not already accepted: the pre-existing 10-char floor
 *     over base62 ALREADY matched `re_evaluation`-style prose, so this sink was
 *     never the one buying prose fidelity, and the widening only extends that
 *     posture to `re_generation_v2`-style prose. Now `re_[A-Za-z0-9_]{10,}`.
 *
 * `re_` still diverges from the transcript twin, deliberately and now in ONE
 * direction only: the transcript copy additionally requires BOTH a digit and an
 * uppercase letter in a body below 20 chars, because a transcript preview is
 * rendered back to the user who wrote it and `re_evaluation` / `re_generation_v2`
 * prose must survive that round trip. So an all-lowercase body between 10 and 19
 * chars is matched HERE and not THERE. That is a real per-sink cost difference
 * and it stays.
 *
 * ISS-6993 added nine families to BOTH sets at once — bare `eyJ` JWTs, PEM
 * private-key blocks, `scheme://user:pass@` URL userinfo, and the `hf_`, `gsk_`,
 * `SG.`, `dapi`, `figd_`, `lin_api_` vendor prefixes. Eight of the nine carry a
 * byte-identical SOURCE STRING in both sets, which is a finding and not a merge:
 * no per-sink cost difference was found for any of them (every body class either
 * excludes `_` or demands a multi-segment shape, so none collides with snake_case
 * prose the way `re_` does), so there was nothing to trade. `urlUserinfoCredential`
 * is the ninth: the transcript copy captures the scheme so it can preserve
 * `scheme://` and the host, which this side has no need to do. The two sets remain
 * separate declarations.
 *
 * FLAGS ARE NOT PART OF THAT EQUIVALENCE, and the difference is universal rather
 * than per-family. This file compiles its whole alternation case-INSENSITIVELY,
 * so every family here also matches at casings its provider never issues; the
 * transcript file compiles each pattern case-SENSITIVELY, by its own stated
 * convention that provider tokens are matched at their documented casing to avoid
 * catching prose. That is true of `ghp_`, `npm_`, and `glpat-` exactly as much as
 * of the families added here — it is a property of the two files' shapes, not a
 * judgement about any one credential — so do not read an identical source string
 * as identical behaviour on a mixed-case input.
 *
 * The divergence list above is prose, but it is no longer the only thing holding
 * the two sets together: `apps/desktop/test/secret-vocabulary-agreement.test.ts`
 * (ISS-6992) fails when a family here has neither a byte-identical transcript
 * twin nor a recorded reason for differing. Reconciling the two sets into ONE
 * declaration is still its own change and still needs a human; never assume a
 * family present in one is covered by the other.
 *
 * Homed at the package root rather than under `src/observability/` on purpose:
 * `exception-sanitizer` is inside the desktop OTel-runtime egress boundary, and
 * `app-otel-runtime-no-egress` (`apps/desktop/scripts/dependency-cruiser.config.cjs`)
 * forbids that boundary from reaching any module path containing
 * "observability". Moving this file under such a path reintroduces that error.
 */

/**
 * One alternative per credential family whose shape is a WORD-ANCHORED token —
 * it both begins and ends on a word character, so it can live inside the shared
 * `\b(?: … )\b` wrapper below. A family that cannot (a PEM block, a URL
 * userinfo run) belongs in {@link SECRET_VALUE_SELF_ANCHORED_SOURCE} instead.
 *
 * Keyed rather than inlined so a consumer's coverage can be derived from the key
 * set — `secret-value-pattern.test.ts` types its fixture table as
 * `Record<SecretValueFamily, string>`, so adding a family here without a fixture
 * is a `tsc` failure rather than a silent gap.
 *
 * Insertion order is preserved deliberately (`Object.values` guarantees it).
 * The families are prefix-disjoint today, so leftmost-match never has a choice
 * to make — but add one that overlaps an existing prefix and order becomes
 * load-bearing, and only the golden assertion in the test would notice.
 *
 * The Google alternatives (`ya29.` access tokens, `1//` refresh tokens) are NOT
 * covered by `bearerToken`: googleapis error messages quote the offending
 * credential bare, with no `Bearer` prefix, so a Google Drive failure routed
 * through `parseError` into `log.error` would otherwise ship a live access token
 * to the sink verbatim. `jwt` is the same argument one layer up: a JWT is the
 * single most common thing a `Bearer` header carries, and an expired-token error
 * quotes it bare.
 */
export const SECRET_VALUE_FAMILY_SOURCE = {
  bearerToken: String.raw`bearer\s+[A-Za-z0-9._~+\/-]{12,}=*`,
  // ISS-6993. Two base64url segments joined by a `.` is the discriminator — a
  // lone `eyJ`-prefixed blob is just base64 and must not match (see the benign
  // fixtures).
  //
  // The trailing `{0,3}` covers a 3-segment JWS, an `alg: none` JWS whose
  // signature segment is empty, and a 5-segment compact JWE. Allowing EMPTY
  // trailing segments widens only how far right a match extends, never whether
  // one starts — the entry condition is still two non-empty segments — so it
  // adds no false positive. Residual, stated rather than hidden: a `dir`-algorithm
  // JWE whose encrypted-key segment is empty fails the second `{8,}` and is not
  // matched.
  jwt: String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,3}`,
  googleAccessToken: String.raw`ya29\.[A-Za-z0-9._~+-]{10,}=*`,
  googleRefreshToken: String.raw`1\/\/[A-Za-z0-9._~+-]{20,}=*`,
  // ISS-6993. SendGrid `SG.<id>.<secret>`. The two-segment shape is what keeps
  // this off prose: this file compiles case-INSENSITIVELY (see the header — that
  // is true of every family here, not this one specially), so a bare `SG\.`
  // would also accept `sg.`, and only the pair of 16-char base64url runs after
  // it makes the alternative unreachable by ordinary text.
  sendGridKey: String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
  // Plain strings below: these alternatives carry no backslash escape, and
  // `String.raw` on one is a `noUselessStringRaw` lint error.
  githubFineGrainedPat: "github_pat_[A-Za-z0-9_]{20,}",
  // ISS-6992: `r` (GitHub OAuth refresh token) was missing here while the
  // transcript twin's `gh[pousr]_` carried it. Drift, not judgement — see the
  // file header.
  githubToken: "gh[oprsu]_[A-Za-z0-9_]{20,}",
  gitlabPat: "glpat-[A-Za-z0-9_-]{20,}",
  npmToken: "npm_[A-Za-z0-9]{20,}",
  // ISS-6992: body class widened from `[A-Za-z0-9]` so it can cross the
  // underscore of a SEGMENTED key. See the file header for why this sink pays
  // nothing new for it.
  resendKey: "re_[A-Za-z0-9_]{10,}",
  openaiKey: "sk-(?:proj-)?[A-Za-z0-9_-]{6,}",
  stripeKey: "sk_(?:live|test)_[A-Za-z0-9]{6,}",
  slackToken: "xox[baprs]-[A-Za-z0-9-]{10,}",
  // ISS-6993 vendor prefixes. Every body class below either excludes `_`
  // (`hf_`, `gsk_`, `lin_api_`) or demands a shape no identifier reaches
  // (`figd_`'s 20-char floor, `dapi`'s 32 hex digits), so none of them can bite
  // a snake_case word the way an unguarded `re_` would.
  huggingFaceToken: "hf_[A-Za-z0-9]{20,}",
  groqKey: "gsk_[A-Za-z0-9]{20,}",
  // `{32,}` and not `{32}`: a FIXED-length run followed by the wrapper's
  // trailing `\b` cannot backtrack, so a 33rd hex digit would make the whole
  // alternative silently unmatchable rather than merely over-long. The class
  // spells out both hex cases even though this file's `i` flag makes that
  // redundant HERE, so the source string stays literally identical to the
  // transcript twin's and a future diff of the two lists is not misled.
  databricksToken: "dapi[a-fA-F0-9]{32,}",
  figmaToken: "figd_[A-Za-z0-9_-]{20,}",
  linearApiKey: "lin_api_[A-Za-z0-9]{20,}",
} as const;

export type SecretValueFamily = keyof typeof SECRET_VALUE_FAMILY_SOURCE;

/**
 * ISS-6898 (review of PR #6476). The two ARMOR LINES of a PEM private-key block,
 * exported so a LINE-ORIENTED consumer can answer "is a block I already emitted
 * still open?" without re-declaring the grammar this file owns — the
 * re-declaration the header forbids. `pemPrivateKeyBlock` below is composed from
 * them, so the family and the armor can never drift apart.
 *
 * They are SOURCE fragments, not patterns: neither is a credential shape on its
 * own, and a consumer that matches only the header has redacted a `-----BEGIN`
 * line and nothing of the key. Use them to decide CONTEXT, and
 * {@link SECRET_VALUE_REPLACE_PATTERN} to scrub.
 */
export const PEM_PRIVATE_KEY_HEADER_SOURCE =
  "-----BEGIN(?:[A-Z ]+)?PRIVATE KEY(?: BLOCK)?-----";
export const PEM_PRIVATE_KEY_FOOTER_SOURCE =
  "-----END(?:[A-Z ]+)?PRIVATE KEY(?: BLOCK)?-----";
/**
 * One WHOLE line of PEM body — the shape the truncated-block fallback below
 * consumes after a header, and therefore the shape a line-oriented consumer must
 * use to decide whether a block it has already emitted is still running. Exported
 * beside the armor for the same reason: so the family and a consumer's framing
 * state cannot drift apart.
 */
export const PEM_PRIVATE_KEY_BODY_LINE_SOURCE = "[A-Za-z0-9+/=]+";

/**
 * ISS-6993. Families that carry their OWN anchoring because the shared
 * `\b(?: … )\b` wrapper below would make them unmatchable, not merely narrow:
 * `\b` demands a word character on the inside of the boundary, and these begin
 * and/or end on `-` or `@`. A PEM block dropped into the wrapper matches
 * NOTHING — the trap the wrapper's own comment warns about, one step further
 * along than the trailing-character case it names.
 *
 * Kept a separate keyed object rather than a flag on the one above so the split
 * is visible at the declaration and so the test can hold its own
 * `Record<SelfAnchoredSecretValueFamily, string>` fixture table — the same
 * `tsc`-enforced coverage guard, not a weaker one.
 *
 * This object holds the self-anchored families whose match extent is UNBOUNDED,
 * which is what earns them a place in {@link UNBOUNDED_SECRET_VALUE_PATTERN} and
 * therefore in the desktop exception path's blank-the-whole-field decision. A
 * self-anchored family whose extent IS bounded goes in
 * {@link SECRET_VALUE_BOUNDED_SOURCE} instead.
 *
 * Each alternative anchors itself, and is LINEAR: `pemPrivateKeyBlock` can only
 * start at a literal `-----BEGIN`.
 */
export const SECRET_VALUE_SELF_ANCHORED_SOURCE = {
  /**
   * The whole block, header to footer, with a second alternative for the
   * TRUNCATED shape — every sink here is length-capped upstream, so a header
   * whose footer was cut off is expected rather than exotic, and everything
   * following a `PRIVATE KEY` header is key material.
   *
   * That fallback is NOT `$`. In JavaScript `$` without `m` asserts the true end
   * of input and nothing else, so an unterminated block swallowed everything to
   * the end of the string INCLUDING a trailing record terminator — on the
   * line-oriented `redacted-jsonl-transcript` caller, which hands this the line
   * with its `\n` still attached, that merged the record with the next one.
   * Instead the fallback takes the rest of the header's own line plus any
   * following WHOLE base64 lines, which is exactly the shape a truncated PEM
   * body has: a multi-line remnant is still consumed, prose on the next line is
   * not, and `\n` survives. A record whose key ran to its end still cannot be
   * closed — there is nothing left to close it with — but it no longer takes the
   * following record with it, and the distinct marker says which case it was.
   *
   * `(?: BLOCK)?` is load-bearing, not decoration: OpenPGP's armor label is
   * `PGP PRIVATE KEY BLOCK-----`, so the literal `PRIVATE KEY-----` never occurs
   * in it and without this the single most common way a human exports a private
   * key (`gpg --export-secret-keys --armor`) matched NOTHING, on every sink.
   * `PGP PUBLIC KEY BLOCK` still declines — `PRIVATE` is literal.
   */
  pemPrivateKeyBlock: String.raw`${PEM_PRIVATE_KEY_HEADER_SOURCE}(?:[\s\S]*?${PEM_PRIVATE_KEY_FOOTER_SOURCE}|[^\n]*(?:\n${PEM_PRIVATE_KEY_BODY_LINE_SOURCE}(?=\n|$))*)`,
} as const;

export type SelfAnchoredSecretValueFamily =
  keyof typeof SECRET_VALUE_SELF_ANCHORED_SOURCE;

/**
 * ISS-6993. Self-anchored families whose match has a KNOWN END, so a consumer
 * can substitute the span in place and keep the surrounding text.
 *
 * The distinction is not cosmetic — it decides whether a desktop exception
 * survives. `apps/desktop/src/shared/exception-sanitizer.ts` blanks an ENTIRE
 * field the moment its secret test matches, and reserves that (per its own
 * comment) for values whose extent is "unbounded and unparseable"; bounded
 * values — paths, URLs, emails — are substituted in place so a stack keeps its
 * frame structure. That in-place behaviour is the ISS-6228/ISS-6229 fix.
 *
 * A `scheme://user:pass@` run terminates at its `@`, so it is bounded, and the
 * sanitizer's existing `URL_VALUE_PATTERN` already replaces the whole URL with
 * `[redacted-url]`. Folding this family into the blank-the-field test would have
 * bought that sink NOTHING — the credential was already gone — while costing the
 * on-call engineer every frame in the stack. So it is excluded from
 * {@link UNBOUNDED_SECRET_VALUE_PATTERN} and included in
 * {@link SECRET_VALUE_PATTERN}, which is what the Datadog/log-drain substitution
 * path uses, and where a `redis://:pw@localhost:6379` leaked BEFORE this family
 * existed: that sink had no URL rule at all, so the only thing removing such a
 * credential was `packages/observability/redact.ts`'s email rule incidentally
 * matching `pass@dotted.host`, and it requires a dotted TLD. A bare hostname, an
 * IPv4 literal, and an IPv6 literal all escaped it.
 *
 * ISS-7086 re-checked that claim against this family and found it CLOSED — the
 * alternative below terminates at its `@` and never consults the host, so all
 * three shapes redact. It was closed as a side effect of adding the family, and
 * nothing pinned it: `packages/observability/__tests__/redact.test.ts`, the suite
 * that owns the leaking sink, carried no credentialed-URL case of any kind, and
 * the cases here used only dotted hosts. Both now cover the four host shapes, so
 * a narrowing that reintroduces a host assumption goes red instead of leaking.
 */
export const SECRET_VALUE_BOUNDED_SOURCE = {
  /**
   * `scheme://user:pass@` — the userinfo run only, terminated by its `@`, so the
   * host and path survive substitution and a connection failure stays
   * diagnosable. The scheme run is capped at 16 characters (`mongodb+srv` is 11)
   * to keep each start offset O(1): uncapped, a long dotted lowercase string
   * gives the engine one unbounded scan per offset — the ISS-6228 failure mode,
   * on the same Electron main-thread crash path, where the length cap is applied
   * only AFTER this scan runs.
   *
   * Both classes stop at `?` and `#` as well as `/`, because all three end the
   * authority (RFC 3986 §3.2) and none may appear unencoded in userinfo. Without
   * that, a URL carrying a PORT and a later `@` — `http://localhost:4318?email=
   * user@example.com` — let the port colon stand in for the user/password
   * separator and the run scan past the `?` to the `@` in the query, so the
   * telemetry sink destroyed a diagnostic that never held a credential (codex
   * review of PR #5339). Only a port makes this reachable: with no `:` before
   * the authority ends there is nothing for the separator to be.
   */
  urlUserinfoCredential: String.raw`\b[a-z][a-z0-9+.-]{0,15}:\/\/[^\s\/:@?#]*:[^\s\/@?#]+@`,
} as const;

export type BoundedSecretValueFamily = keyof typeof SECRET_VALUE_BOUNDED_SOURCE;

// The `\b` anchors wrap the word-anchored alternation, not each alternative, so
// such a match must both begin and END on a word character. Every family in
// `SECRET_VALUE_FAMILY_SOURCE` CAN: their trailing quantified classes all accept
// alphanumerics, and the engine backtracks to one when the greedy run overshoots
// onto `.`, `-`, `~`, `+`, `/` or `=`. Three shapes would silently never match —
// an alternative whose FIRST or last element is a fixed non-word character, and
// one whose minimum-length body can only be non-word characters (`bearer
// ------------` is already unmatchable, because the run cannot backtrack below
// its `{12,}` floor). The first two are why
// `SECRET_VALUE_SELF_ANCHORED_SOURCE` exists and sits OUTSIDE this wrapper.
const WORD_ANCHORED_SECRET_SOURCE = String.raw`\b(?:${Object.values(SECRET_VALUE_FAMILY_SOURCE).join("|")})\b`;

const UNBOUNDED_SECRET_VALUE_SOURCE = `(?:${WORD_ANCHORED_SECRET_SOURCE}|${Object.values(SECRET_VALUE_SELF_ANCHORED_SOURCE).join("|")})`;

const SECRET_VALUE_SOURCE = `(?:${WORD_ANCHORED_SECRET_SOURCE}|${Object.values(SECRET_VALUE_SELF_ANCHORED_SOURCE).join("|")}|${Object.values(SECRET_VALUE_BOUNDED_SOURCE).join("|")})`;

/**
 * Case-insensitive and NON-global, so a caller may `.test()` it without
 * inheriting a stale `lastIndex`. Substitution uses the global twin below.
 *
 * The WHOLE vocabulary — use this to decide "does this text carry a credential",
 * and use {@link SECRET_VALUE_REPLACE_PATTERN} to scrub one out. A caller that
 * reacts to a match by discarding surrounding text wants
 * {@link UNBOUNDED_SECRET_VALUE_PATTERN} instead.
 */
export const SECRET_VALUE_PATTERN = new RegExp(SECRET_VALUE_SOURCE, "i");

/**
 * {@link SECRET_VALUE_PATTERN} minus the bounded families — every credential
 * shape whose extent this file CANNOT determine.
 *
 * For the one consumer that answers a match by throwing away everything around
 * it: `apps/desktop/src/shared/exception-sanitizer.ts` blanks an entire
 * exception field on a hit. That is right for a token whose tail is unbounded
 * and unparseable, and wrong for a value the sanitizer can already substitute in
 * place — blanking there destroys a stack to re-remove a credential its own
 * `URL_VALUE_PATTERN` had removed anyway. Non-global, for the same `lastIndex`
 * reason as its parent.
 */
export const UNBOUNDED_SECRET_VALUE_PATTERN = new RegExp(
  UNBOUNDED_SECRET_VALUE_SOURCE,
  "i"
);

/**
 * The global twin of {@link SECRET_VALUE_PATTERN}, for `.replace()` — every
 * occurrence in a string is scrubbed, not just the first.
 *
 * For `String.replace`/`replaceAll` ONLY. Never `.test()` or `.exec()` it: those
 * consult and advance `lastIndex` on a global regex, so identical inputs
 * alternate true/false and a secret slips through on every other call. Use
 * {@link SECRET_VALUE_PATTERN} for a boolean check.
 */
export const SECRET_VALUE_REPLACE_PATTERN = new RegExp(
  SECRET_VALUE_SOURCE,
  "gi"
);
