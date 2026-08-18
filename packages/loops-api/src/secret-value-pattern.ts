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
 *
 * NOT the whole repo's secret vocabulary. `packages/lib/security/redact-secrets`
 * is a separate redactor for a different sink (session-transcript metadata
 * crossing to the cloud DB and UI) with its own labelled `[REDACTED:<label>]`
 * markers and a deliberately different family set. As of ISS-6233 it carries
 * AWS `AKIA`/`ASIA`, Google `AIza`, Stripe `whsec_`, Stripe `rk_`/`pk_`, the
 * bare `Authorization: <credential>` header form, and GitHub `ghr_` (its class
 * is `gh[pousr]_`; this file's `githubToken` is `gh[opsu]_` and does NOT cover
 * `ghr_`) — none of which this set matches. It in turn lacks the `ya29.`, `1//`,
 * `glpat-`, `npm_`, and `re_` shapes this one has. That list is accurate as of
 * this commit and is NOT self-enforcing. Reconciling the two sets is its own
 * change; never assume a family present in one is covered by the other.
 *
 * Homed at the package root rather than under `src/observability/` on purpose:
 * `exception-sanitizer` is inside the desktop OTel-runtime egress boundary, and
 * `app-otel-runtime-no-egress` (`apps/desktop/scripts/dependency-cruiser.config.cjs`)
 * forbids that boundary from reaching any module path containing
 * "observability". Moving this file under such a path reintroduces that error.
 */

/**
 * One alternative per credential family. Keyed rather than inlined so a
 * consumer's coverage can be derived from the key set — `secret-value-pattern.test.ts`
 * types its fixture table as `Record<SecretValueFamily, string>`, so adding a
 * family here without a fixture is a `tsc` failure rather than a silent gap.
 *
 * Insertion order is preserved deliberately (`Object.values` guarantees it) so
 * the assembled source stays byte-identical to the two literals this replaced.
 * The families are prefix-disjoint today, so leftmost-match never has a choice
 * to make — but add one that overlaps an existing prefix and order becomes
 * load-bearing, and only the golden assertion in the test would notice.
 *
 * The Google alternatives (`ya29.` access tokens, `1//` refresh tokens) are NOT
 * covered by `bearerToken`: googleapis error messages quote the offending
 * credential bare, with no `Bearer` prefix, so a Google Drive failure routed
 * through `parseError` into `log.error` would otherwise ship a live access token
 * to the sink verbatim.
 */
export const SECRET_VALUE_FAMILY_SOURCE = {
  bearerToken: String.raw`bearer\s+[A-Za-z0-9._~+\/-]{12,}=*`,
  googleAccessToken: String.raw`ya29\.[A-Za-z0-9._~+-]{10,}=*`,
  googleRefreshToken: String.raw`1\/\/[A-Za-z0-9._~+-]{20,}=*`,
  // Plain strings below: these alternatives carry no backslash escape, and
  // `String.raw` on one is a `noUselessStringRaw` lint error.
  githubFineGrainedPat: "github_pat_[A-Za-z0-9_]{20,}",
  githubToken: "gh[opsu]_[A-Za-z0-9_]{20,}",
  gitlabPat: "glpat-[A-Za-z0-9_-]{20,}",
  npmToken: "npm_[A-Za-z0-9]{20,}",
  resendKey: "re_[A-Za-z0-9]{10,}",
  openaiKey: "sk-(?:proj-)?[A-Za-z0-9_-]{6,}",
  stripeKey: "sk_(?:live|test)_[A-Za-z0-9]{6,}",
  slackToken: "xox[baprs]-[A-Za-z0-9-]{10,}",
} as const;

export type SecretValueFamily = keyof typeof SECRET_VALUE_FAMILY_SOURCE;

// The `\b` anchors wrap the whole alternation, not each alternative, so a match
// must both begin and END on a word character. Every family above CAN: their
// trailing quantified classes all accept alphanumerics, and the engine
// backtracks to one when the greedy run overshoots onto `.`, `-`, `~`, `+`, `/`
// or `=`. Two shapes would silently never match — an alternative whose last
// element is a fixed non-word character, and one whose minimum-length body can
// only be non-word characters (`bearer ------------` is already unmatchable,
// because the run cannot backtrack below its `{12,}` floor).
const SECRET_VALUE_SOURCE = String.raw`\b(?:${Object.values(SECRET_VALUE_FAMILY_SOURCE).join("|")})\b`;

/**
 * Case-insensitive and NON-global, so a caller may `.test()` it without
 * inheriting a stale `lastIndex`. Substitution uses the global twin below.
 */
export const SECRET_VALUE_PATTERN = new RegExp(SECRET_VALUE_SOURCE, "i");

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
