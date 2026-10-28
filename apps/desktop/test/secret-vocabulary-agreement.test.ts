/**
 * @file secret-vocabulary-agreement.test.ts
 * @description ISS-6992 — the guard the two secret vocabularies never had.
 *
 * This repo carries TWO credential-shape vocabularies on purpose, and they stay
 * separate declarations: `@closedloop-ai/loops-api/secret-value-pattern` fronts the
 * telemetry sinks (Datadog intake, log-drain line, desktop exception path) and
 * `@repo/lib/security/redact-secrets` fronts the session-transcript sinks (cloud
 * DB and UI preview, redacted JSONL upload, agent-coaching payload). Merging
 * them is explicitly a human's call (`packages/loops-api/AGENTS.md`) because it
 * would make each sink redact the other's union.
 *
 * What was NOT deliberate is drift. Until ISS-6992 the only thing keeping the
 * two lists in agreement was a prose enumeration in each file's header, and it
 * silently went wrong twice: `gh[opsu]_` against `gh[pousr]_` shipped a `ghr_`
 * refresh token to three telemetry sinks in clear, and a `re_` body class that
 * could not cross an underscore did the same for every segmented Resend key.
 *
 * So this file turns the enumeration into a test. Every telemetry family must be
 * EITHER byte-identical to a transcript pattern (modulo the `\b` the telemetry
 * side factors into its shared wrapper) OR listed below with the reason it
 * differs. A new family added to one side alone, or an existing pair quietly
 * drifting apart, fails here instead of leaking.
 *
 * It lives in `apps/desktop` because this is the one surface that already
 * imports BOTH — the exception path uses the telemetry vocabulary and the
 * coaching path uses the transcript one — so the test needs no new package
 * dependency edge to exist.
 */

import assert from "node:assert/strict";
import {
  SECRET_VALUE_BOUNDED_SOURCE,
  SECRET_VALUE_FAMILY_SOURCE,
  SECRET_VALUE_SELF_ANCHORED_SOURCE,
} from "@closedloop-ai/loops-api/secret-value-pattern";
import { SECRET_PATTERN_SOURCES } from "@repo/lib/security/redact-secrets.js";
import { test } from "vitest";

const TELEMETRY_FAMILY_SOURCES: Record<string, string> = {
  ...SECRET_VALUE_FAMILY_SOURCE,
  ...SECRET_VALUE_SELF_ANCHORED_SOURCE,
  ...SECRET_VALUE_BOUNDED_SOURCE,
};

/**
 * Families whose two declarations are deliberately NOT byte-identical, each with
 * the reason. Adding an entry here is a claim that a human decided the sinks
 * should differ for that family — it is not a place to park a drift you did not
 * mean.
 *
 * Every entry below predates ISS-6992 except `urlUserinfoCredential`. They are
 * recorded rather than reconciled: reconciling any of them changes what a sink
 * redacts, which is the contract decision `packages/loops-api/AGENTS.md` reserves
 * for a human.
 */
const INTENTIONAL_DIVERGENCE: Record<string, string> = {
  bearerToken:
    "the transcript side CAPTURES and re-emits the scheme word (`Bearer [REDACTED:bearer]`) and floors the credential at 16 chars; telemetry has no capture and floors at 12",
  googleAccessToken:
    "telemetry additionally accepts trailing `=*` base64 padding (pre-existing, ISS-6233)",
  googleRefreshToken:
    "telemetry additionally accepts trailing `=*` base64 padding (pre-existing, ISS-6233)",
  githubToken:
    "ISS-6992 equalised the PREFIX sets, not the shapes: telemetry's body class still allows `_` and the transcript's does not, and the class members are written in a different order",
  resendKey:
    "the one family with a stated per-sink cost: the transcript copy demands a digit AND an uppercase letter below 20 chars so `re_evaluation` prose survives being rendered back to the user who wrote it (ISS-6799, narrowed to one direction by ISS-6992)",
  openaiKey:
    "the transcript side splits this into three patterns with distinct labels (`sk-ant`, `sk-openai`, `sk`) and a 32-char floor against telemetry's single 6-char rule",
  stripeKey:
    "the transcript side also covers `rk_`/`pk_`, captures the prefix to build the label, and floors at 8 against telemetry's 6",
  urlUserinfoCredential:
    "ISS-6993: the transcript side captures the scheme so it can preserve `scheme://` and the host and redact only the userinfo run; telemetry has no capture because its consumers replace the whole match",
};

/** The telemetry side factors `\b` into its shared wrapper; the transcript side spells it per pattern. */
const LEADING_WORD_ANCHOR = /^\\b/;
const TRANSCRIPT_SOURCES_WITHOUT_WORD_ANCHOR = new Set(
  SECRET_PATTERN_SOURCES.map((source) =>
    source.replace(LEADING_WORD_ANCHOR, "")
  )
);

test("every telemetry family is byte-identical to a transcript pattern or a recorded divergence", () => {
  const undocumented: string[] = [];

  for (const [family, source] of Object.entries(TELEMETRY_FAMILY_SOURCES)) {
    if (TRANSCRIPT_SOURCES_WITHOUT_WORD_ANCHOR.has(source)) {
      continue;
    }
    if (!INTENTIONAL_DIVERGENCE[family]) {
      undocumented.push(family);
    }
  }

  assert.deepEqual(
    undocumented,
    [],
    `These telemetry families have no byte-identical transcript twin and no recorded reason. Either add the family to packages/lib/security/redact-secrets.ts, or add it to INTENTIONAL_DIVERGENCE above with why the two sinks should differ: ${undocumented.join(", ")}`
  );
});

test("no divergence is recorded for a family that actually agrees", () => {
  // The other direction, so the list cannot rot into a pile of stale claims that
  // quietly excuse a future real drift. If someone reconciles a pair, this makes
  // them delete the entry rather than leave a comment asserting a difference
  // that no longer exists.
  const staleClaims = Object.keys(INTENTIONAL_DIVERGENCE).filter((family) => {
    const source = TELEMETRY_FAMILY_SOURCES[family];
    return (
      source !== undefined && TRANSCRIPT_SOURCES_WITHOUT_WORD_ANCHOR.has(source)
    );
  });

  assert.deepEqual(
    staleClaims,
    [],
    `These families now agree byte-for-byte, so their INTENTIONAL_DIVERGENCE entries are stale and must be deleted: ${staleClaims.join(", ")}`
  );
});

test("no divergence is recorded for a family that no longer exists", () => {
  const orphans = Object.keys(INTENTIONAL_DIVERGENCE).filter(
    (family) => TELEMETRY_FAMILY_SOURCES[family] === undefined
  );

  assert.deepEqual(
    orphans,
    [],
    `INTENTIONAL_DIVERGENCE names families the telemetry vocabulary no longer declares: ${orphans.join(", ")}`
  );
});

test("the ISS-6993 families really are the byte-identical set the headers claim", () => {
  // Both file headers state these nine were added to both sets at once and came
  // out byte-equivalent. That claim is what this pins — the `dapi` class was
  // written `[a-f0-9]` on one side and `[a-fA-F0-9]` on the other and agreed only
  // because the telemetry regex is compiled `i` in a different file.
  // `urlUserinfoCredential` is the one exception and carries its reason above.
  const claimedIdentical = [
    "jwt",
    "sendGridKey",
    "huggingFaceToken",
    "groqKey",
    "databricksToken",
    "figmaToken",
    "linearApiKey",
    "pemPrivateKeyBlock",
  ];

  const notIdentical = claimedIdentical.filter(
    (family) =>
      !TRANSCRIPT_SOURCES_WITHOUT_WORD_ANCHOR.has(
        TELEMETRY_FAMILY_SOURCES[family] ?? ""
      )
  );

  assert.deepEqual(
    notIdentical,
    [],
    `drifted from their twin: ${notIdentical.join(", ")}`
  );
});
