import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { JSDOM } from "jsdom";

/**
 * ISS-11059: re-measure, on every build, the static 500 document whose
 * unnonced scripts ISS-10063 accepted, and fail when a fact that acceptance
 * rests on stops being true. The document is Next's synthetic `_global-error`,
 * built with no request, so its scripts cannot carry the per-request nonce and
 * the enforcing policy blocks them. It is acceptable only while:
 *
 * - its only control is a form submit that retries the url without JavaScript;
 * - it is still that synthetic copy, mapped at `/500` as the only pages-router
 *   entry — a Next change to how it is built means measuring again, not
 *   assuming.
 *
 * The manifest also pins a `next start` fact: with no `/_document` or `/_app`,
 * `next start` cannot load `/500` and answers a crash with a plain-text 500
 * (measured on 16.3.3). On Vercel, a page crash outside app-render's recovery
 * serves this document regardless (ISS-11059).
 */

const EXPECTED_PAGES_MANIFEST = { "/500": "pages/500.html" };
const INTERACTIVE_ELEMENTS =
  "a[href], button, input, select, textarea, [contenteditable], [tabindex]";
const SUBMISSION_OVERRIDES = ["action", "method", "formaction", "formmethod"];
const EVENT_HANDLER_ATTRIBUTE = /^on/i;
const JAVASCRIPT_URL = /^\s*javascript:/i;
// ISS-12054 re-measured 19 -> 18: the `@repo/auth/client` graph change regrouped
// the same client code (1,204,882 vs 1,204,838 bytes across the external
// chunks) into 16 external chunks instead of 17; still 0 nonced, the same two
// inline flight scripts, and the form submit as the only control.
// ISS-12940 re-measured 18 -> 19: Next 16.4.1 (#9089) defaults
// `experimental.turbopackSharedRuntime` to true, which inlines the chunk-group
// bootstrap (`<script id="_R_">`, 475 bytes, no nonce) that 16.3.6 loaded as an
// external chunk; still 16 external chunks, 0 nonced, the same two inline
// flight scripts, and the form submit as the only control.
const EXPECTED_SCRIPT_COUNT = 19;
const EXPECTED_NONCED_SCRIPT_COUNT = 0;

/**
 * `readFileSync`, but a missing file is AC2 (Next stops emitting one of the
 * files this acceptance is measured against) — a finding to re-measure, not a
 * raw ENOENT stack out of a next-build CI lane.
 */
function readOptional(filePath, findings) {
  try {
    return readFileSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      findings.push(
        `${filePath} no longer exists — ISS-10063's acceptance no longer holds, re-measure before changing this check`
      );
      return null;
    }
    throw error;
  }
}

/** Findings against the built server output in `serverDir` (`.next/server`). */
export function inspectStatic500(serverDir) {
  const findings = [];

  const manifestRaw = readOptional(
    path.join(serverDir, "pages-manifest.json"),
    findings
  );
  if (manifestRaw !== null) {
    const manifest = JSON.parse(manifestRaw.toString("utf8"));
    if (!isDeepStrictEqual(manifest, EXPECTED_PAGES_MANIFEST)) {
      findings.push(
        `pages-manifest.json is ${JSON.stringify(manifest)}, expected ${JSON.stringify(EXPECTED_PAGES_MANIFEST)}`
      );
    }
  }

  const page = readOptional(
    path.join(serverDir, "pages", "500.html"),
    findings
  );
  const globalError = readOptional(
    path.join(serverDir, "app", "_global-error.html"),
    findings
  );
  if (page !== null && globalError !== null && !page.equals(globalError)) {
    findings.push(
      "pages/500.html is no longer a copy of app/_global-error.html"
    );
  }

  if (page === null) {
    return { findings, scripts: 0, noncedScripts: 0 };
  }

  const { document } = new JSDOM(page.toString("utf8")).window;
  findings.push(...controlFindings(document));
  const scripts = [...document.querySelectorAll("script")];
  return {
    findings,
    scripts: scripts.length,
    noncedScripts: scripts.filter((script) => script.hasAttribute("nonce"))
      .length,
  };
}

/**
 * Findings for drift from the exact counts ISS-11059 measured. A predicate
 * pass with a changed count means the acceptance's premises changed too —
 * logging the number is not the same as failing on it.
 */
export function measurementDriftFindings(scripts, noncedScripts) {
  const findings = [];
  if (scripts !== EXPECTED_SCRIPT_COUNT) {
    findings.push(
      `script count is ${scripts}, expected ${EXPECTED_SCRIPT_COUNT} — re-measure before changing this check`
    );
  }
  if (noncedScripts !== EXPECTED_NONCED_SCRIPT_COUNT) {
    findings.push(
      `nonced script count is ${noncedScripts}, expected ${EXPECTED_NONCED_SCRIPT_COUNT} — re-measure before changing this check`
    );
  }
  return findings;
}

function controlFindings(document) {
  const findings = [];
  const forms = [...document.querySelectorAll("form")];
  const controls = [...document.querySelectorAll(INTERACTIVE_ELEMENTS)];
  const [form] = forms;
  const [control] = controls;
  const isOneEnabledSubmitInOneForm =
    forms.length === 1 &&
    controls.length === 1 &&
    control.form === form &&
    control.localName === "button" &&
    control.type === "submit" &&
    !isEffectivelyDisabled(control);
  if (!isOneEnabledSubmitInOneForm) {
    findings.push(
      `expected one enabled submit button inside one form as the only control, found ${forms.length} form(s) and ${controls.map((el) => el.outerHTML).join(", ") || "no controls"}`
    );
  }
  for (const element of [form, control].filter(Boolean)) {
    for (const name of SUBMISSION_OVERRIDES) {
      if (element.hasAttribute(name)) {
        findings.push(`<${element.localName}> sets ${name}`);
      }
    }
  }
  for (const element of document.querySelectorAll("*")) {
    for (const { name, value } of element.attributes) {
      if (EVENT_HANDLER_ATTRIBUTE.test(name) || JAVASCRIPT_URL.test(value)) {
        findings.push(`<${element.localName}> carries ${name}="${value}"`);
      }
    }
  }
  return findings;
}

/**
 * A `<fieldset disabled>` ancestor disables its descendants without setting
 * their own `disabled` IDL attribute — except descendants of that fieldset's
 * first `<legend>` child, which the HTML spec exempts. Reading `.disabled`
 * alone misses the fieldset case; reading only the fieldset misses a directly
 * disabled control.
 */
function isEffectivelyDisabled(control) {
  if (control.disabled) {
    return true;
  }
  for (
    let ancestor = control.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor.localName !== "fieldset" || !ancestor.disabled) {
      continue;
    }
    const firstLegend = ancestor.querySelector(":scope > legend");
    if (!firstLegend?.contains(control)) {
      return true;
    }
  }
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const serverDir =
    process.argv[2] ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../.next/server");
  const { findings, scripts, noncedScripts } = inspectStatic500(serverDir);
  findings.push(...measurementDriftFindings(scripts, noncedScripts));
  console.log(
    `static 500 document: ${scripts} script(s), ${noncedScripts} nonced`
  );
  if (findings.length > 0) {
    console.error(
      `ISS-10063's acceptance no longer holds — re-measure before changing this check:\n- ${findings.join("\n- ")}`
    );
    process.exit(1);
  }
}
