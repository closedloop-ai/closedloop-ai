// @ts-check

/**
 * ISS-5303 — the macOS signing/notarization secret classification behind
 * `scripts/run-electron-builder.mjs`.
 *
 * The entrypoint stays a thin shell (stat the staged app, spawn
 * electron-builder, propagate the exit code). The decision it makes BEFORE
 * spawning — is this a signed release build, an unsigned local build, or a
 * broken secret configuration we must refuse — lives here, parameterized over
 * an injected env object so it can be driven without touching `process.env`.
 *
 * Why it is a classification and not a boolean: "the signing secrets are all
 * here" and "I cannot tell whether they are here" must not collapse to the same
 * answer. Collapsing them is exactly the failure this guard was written for —
 * a referenced-but-unshared GitHub org secret expands to `""`, electron-builder
 * treats an empty `CSC_LINK` as a certificate path (and dies cryptically) or
 * silently SKIPS notarization, and CI goes green on a DMG Gatekeeper blocks.
 */

/**
 * The five vars the release workflow sets together from org-level secrets.
 * Signing and notarization are one unit: a signed-but-un-notarized DMG is an
 * unusable build, so partial configuration is never "signable".
 */
export const REQUIRED_MAC_SIGNING_ENV_VARS = Object.freeze([
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
]);

/**
 * Outcome of {@link classifyMacSigningEnv}.
 *
 * - `signed` — all five present and non-empty; the release signing path.
 * - `unsigned` — none of the five defined; the local / ad-hoc build path, where
 *   electron-builder ad-hoc-signs and notarization is skipped BY DESIGN.
 * - `partial` — some defined and non-empty, others entirely absent. Not
 *   signable, and deliberately distinct from `signed`.
 * - `misconfigured` — at least one is defined but empty (or whitespace). This
 *   is the fail-closed case the entrypoint refuses to build on.
 *
 * `misconfigured` outranks the others: an empty-defined var is a broken secret
 * wiring no matter how many of its siblings look fine.
 */
export const MacSigningMode = Object.freeze({
  Signed: "signed",
  Unsigned: "unsigned",
  Partial: "partial",
  Misconfigured: "misconfigured",
});

/**
 * @typedef {object} MacSigningClassification
 * @property {"signed" | "unsigned" | "partial" | "misconfigured"} mode
 * @property {string[]} emptyDefined Required vars that are defined but blank.
 * @property {string[]} absent Required vars that are not defined at all.
 * @property {string[]} configured Required vars carrying a non-blank value.
 */

/**
 * Classify an environment's macOS signing secrets.
 *
 * Unset (as opposed to empty) vars are intentionally tolerated by the caller:
 * that is how a developer builds locally without a certificate. What is never
 * tolerated is a var that exists and carries nothing — that means a secret
 * reference resolved to the empty string.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {MacSigningClassification}
 */
export function classifyMacSigningEnv(env) {
  /** @type {string[]} */
  const emptyDefined = [];
  /** @type {string[]} */
  const absent = [];
  /** @type {string[]} */
  const configured = [];

  for (const name of REQUIRED_MAC_SIGNING_ENV_VARS) {
    if (!(name in env)) {
      absent.push(name);
      continue;
    }
    if ((env[name] ?? "").trim() === "") {
      emptyDefined.push(name);
      continue;
    }
    configured.push(name);
  }

  return {
    mode: macSigningMode(emptyDefined, absent, configured),
    emptyDefined,
    absent,
    configured,
  };
}

/**
 * The refusal message for a `misconfigured` environment.
 *
 * It names the offending vars and both remedies, because the two audiences hit
 * this from opposite directions: CI needs the org-secret sharing fixed, a
 * developer needs to UNSET the vars rather than blank them.
 *
 * @param {readonly string[]} emptyDefinedNames
 * @returns {string}
 */
export function macSigningFailureMessage(emptyDefinedNames) {
  return [
    `macOS signing/notarization env var(s) defined but empty: ${emptyDefinedNames.join(", ")}.`,
    "This usually means the org-level Apple signing secrets are not shared with this",
    "repository, so the workflow's secrets.APPLE_* references expand to empty",
    "strings. Ask an org admin to add this repo to the repository access of the",
    "closedloop-ai org secrets: APPLE_CSC_LINK, APPLE_CSC_KEY_PASSWORD, APPLE_ID,",
    "APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID (Org → Settings → Secrets and",
    "variables → Actions → Organization secrets).",
    "",
    "To build locally WITHOUT signing, unset CSC_LINK/CSC_KEY_PASSWORD entirely",
    "(leave them undefined) so electron-builder ad-hoc-signs the app.",
  ].join("\n");
}

/**
 * @param {readonly string[]} emptyDefined
 * @param {readonly string[]} absent
 * @param {readonly string[]} configured
 * @returns {"signed" | "unsigned" | "partial" | "misconfigured"}
 */
function macSigningMode(emptyDefined, absent, configured) {
  if (emptyDefined.length > 0) {
    return MacSigningMode.Misconfigured;
  }
  if (absent.length === 0) {
    return MacSigningMode.Signed;
  }
  if (configured.length === 0) {
    return MacSigningMode.Unsigned;
  }
  return MacSigningMode.Partial;
}
