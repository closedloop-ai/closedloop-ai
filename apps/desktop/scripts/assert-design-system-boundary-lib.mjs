// @ts-check
/**
 * ISS-7240 — the decision half of the design-system boundary gate.
 *
 * The gate used to be a bare `depcruise src`, which is a check with exactly one
 * failure mode it CANNOT report: inspecting nothing. Between 2026-08-11 and
 * this change it did precisely that. dependency-cruiser probes for a compiler
 * with `tryImportAvailable("typescript", ">=2.0.0 <7.0.0")`; PLN-1678 moved the
 * workspace to typescript@7, which fails that range, so `.ts` dropped out of
 * `scannableExtensions` — ONE list feeding both the directory scan and the
 * enhanced-resolve `extensions`. `depcruise src` gathered 0 modules and exited
 * 0, and every one of the gate's call sites reported success while enforcing
 * nothing. Two boot-path regressions landed through that window.
 *
 * So the gate now asserts what it INSPECTED, not only what it found. The two
 * checks below are ordered cause-then-effect deliberately: a missing TypeScript
 * is the specific, actionable failure, and reporting it as "too few modules"
 * would make the next lane re-derive the diagnosis ISS-7100 already did.
 *
 * Pure and injectable so the refusals can be tested without a ~19s cruise of
 * the real tree — the `-lib` split every other entrypoint in this directory
 * uses (see scripts/tooling-reach-ledger.mjs).
 */

/**
 * Lowest module count a healthy cruise of `src` may report.
 *
 * ISS-7240's acceptance criterion is a "four-figure module count", so the floor
 * IS four figures. The real cruise reports ~2258, so this leaves generous room
 * for the tree to shrink while still failing loudly on the only regression that
 * matters — the count collapsing toward zero because the graph stopped being
 * gathered at all. Deliberately not pinned near the live number: a tight floor
 * would red the gate on ordinary refactors and teach people to lower it, which
 * is how a floor becomes decorative.
 */
export const MODULE_FLOOR = 1000;

/** The transpiler dependency-cruiser must have to see `.ts` at all. */
export const REQUIRED_TRANSPILER = "typescript";

/**
 * @typedef {object} TranspilerAvailability
 * @property {string} name
 * @property {string} version The range dependency-cruiser accepts.
 * @property {boolean} available
 * @property {string} [currentVersion] What actually resolved. Present at
 *   runtime but absent from dependency-cruiser's published
 *   `IAvailableTranspiler`, so it is optional here and every read degrades —
 *   diagnostics must never be the reason a gate cannot run.
 */

/**
 * @typedef {object} BoundaryVerdict
 * @property {boolean} ok
 * @property {string} [reason] Operator-facing refusal, absent when ok.
 */

/**
 * Decide whether dependency-cruiser can see TypeScript.
 *
 * @param {readonly TranspilerAvailability[]} transpilers From the public
 *   `getAvailableTranspilers()`; asking the tool rather than re-deriving its
 *   probe means a widened upstream range is inherited, never contradicted.
 * @returns {BoundaryVerdict}
 */
export function checkTypeScriptVisible(transpilers) {
  const typescript = transpilers.find(
    (entry) => entry.name === REQUIRED_TRANSPILER
  );
  if (!typescript) {
    return {
      ok: false,
      reason: `dependency-cruiser reports no "${REQUIRED_TRANSPILER}" transpiler slot at all. It cannot parse .ts, so this gate would inspect nothing.`,
    };
  }
  if (!typescript.available) {
    return {
      ok: false,
      reason: [
        "dependency-cruiser cannot see TypeScript, so .ts is not scannable and this gate would inspect NOTHING (it would exit 0 having cruised 0 modules).",
        `It accepts ${REQUIRED_TRANSPILER}@"${typescript.version}" and resolved: ${typescript.currentVersion ?? "nothing"}.`,
        "Fix: the pnpm-workspace.yaml packageExtensions entry that gives dependency-cruiser its own in-range typescript (npm:@typescript/typescript6) is missing, was removed, or needs a reinstall. Do NOT work around this by narrowing what the gate cruises — that reproduces ISS-7240.",
      ].join("\n"),
    };
  }
  return { ok: true };
}

/**
 * Render violations the way the `err` reporter does — severity, rule,
 * endpoints, then the hops in between.
 *
 * The `via` chain is the part worth keeping: these rules are `reachable: true`,
 * so the offending import is almost never in the file named on the left, and
 * printing only the endpoints sends the reader to the wrong module.
 *
 * Severity is READ, never assumed. Every rule in the config is `error` today,
 * but hardcoding that would relabel a future `warn` as a blocking failure — a
 * gate that misreports what it found is the same class of defect as one that
 * reports nothing.
 *
 * @param {readonly BoundaryViolation[]} violations
 * @returns {string}
 */
export function formatViolations(violations) {
  return violations
    .map((violation) => {
      const severity = violation.rule.severity ?? "error";
      const header = `  ${severity} ${violation.rule.name}: ${violation.from} → ${violation.to}`;
      const hops = (violation.via ?? []).map((hop) => `      ${hop.name} →`);
      return [header, ...hops].join("\n");
    })
    .join("\n");
}

/**
 * Summarize a cruise's violations for the operator.
 *
 * Blocking is `error` severity only — that is what the exit code has always
 * meant. But a non-blocking violation still has to be SEEN: taking both the
 * verdict and the printed set from `summary.error` would let a `warn` rule fire
 * while the gate prints "no dependency violations found", which is a
 * partially-clean cruise reported as a fully-clean one.
 *
 * @param {readonly BoundaryViolation[]} violations
 * @returns {{blocking: number, nonBlocking: number}}
 */
export function tallyViolations(violations) {
  let blocking = 0;
  let nonBlocking = 0;
  for (const violation of violations) {
    if ((violation.rule.severity ?? "error") === "error") {
      blocking += 1;
    } else {
      nonBlocking += 1;
    }
  }
  return { blocking, nonBlocking };
}

/**
 * Decide whether a cruise actually inspected the module graph.
 *
 * @param {number} totalCruised
 * @param {number} [floor]
 * @returns {BoundaryVerdict}
 */
export function checkModuleFloor(totalCruised, floor = MODULE_FLOOR) {
  if (totalCruised >= floor) {
    return { ok: true };
  }
  const inspectedNothing = totalCruised === 0;
  return {
    ok: false,
    reason: [
      `the boundary cruise gathered ${totalCruised} modules, below the floor of ${floor}.`,
      inspectedNothing
        ? "ZERO modules means the gate inspected nothing and its green would have been meaningless — this is the ISS-7240 failure mode recurring."
        : "That is far below a healthy cruise of src (~2258), so the graph is being gathered only partially.",
      "Do NOT lower this floor to get green. Find out why the graph shrank.",
    ].join("\n"),
  };
}
