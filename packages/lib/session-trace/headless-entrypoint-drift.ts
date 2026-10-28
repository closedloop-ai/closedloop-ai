/**
 * @file headless-entrypoint-drift.ts
 * @description ISS-7260: make the headless classifier's DEFAULT audible.
 *
 * `isHeadlessEntrypoint` is a string heuristic over a set upstream owns. A value
 * that matches no rule is classified interactive, which is the right default —
 * positive evidence only, so missing data never demotes a genuine typed prompt —
 * but it is also indistinguishable, from the outside, from a value the repo has
 * actually ruled on. That is the failure mode the ticket names: rename `sdk-cli`
 * to `sdkcli` upstream and 1,285 autonomous sessions become "human-steered", the
 * `is_human` rollup flips, the heatmap repaints, and nothing anywhere says so.
 *
 * This reports the fall-through instead of leaving it silent. It classifies
 * NOTHING differently and is not a gate — an unrecognized value still lands
 * interactive, exactly as before. Same posture, and the same wording, as
 * `parse-claude-drift.ts`: the report is silent against a corpus of known values,
 * and the first thing it says is that the harness started sending something new.
 *
 * Bounded twice over, because both the value and its cardinality come from
 * outside: each distinct value is reported ONCE, and the retained set stops
 * growing at {@link MAX_REPORTED_UNRECOGNIZED_ENTRYPOINTS} with one line saying
 * it did. A corpus of 3,000 sessions therefore costs at most that many lines, not
 * one per session.
 */
import { renderDiagnosticName } from "../diagnostics/log-safe-text";
import { redactSecrets } from "../security/redact-secrets";
import { classifyEntrypoint, EntrypointClass } from "./headless";

/**
 * Ceiling on distinct unrecognized values retained and reported per reporter.
 *
 * The values are harness-controlled, so an unbounded set is an unbounded map keyed
 * by external input in a process that runs for days. Generous enough that a real
 * rename — one or two new spellings, a harness family — is reported in full, with
 * an explicit line when it is not.
 */
export const MAX_REPORTED_UNRECOGNIZED_ENTRYPOINTS = 20;

export type UnrecognizedEntrypointReporter = {
  /**
   * Returns the line to log the FIRST time this value is seen unrecognized, and
   * `undefined` every other time — for a recognized value, an absent one, a
   * repeat, and anything past the cap.
   */
  note(entrypoint: string | null | undefined): string | undefined;
};

/**
 * A stateful, bounded reporter. Deliberately a factory rather than module state:
 * the caller decides the lifetime (one per process for an import loop, a fresh
 * one per test), and nothing needs a reset hook that production would never call.
 */
export function createUnrecognizedEntrypointReporter(options?: {
  maxReported?: number;
}): UnrecognizedEntrypointReporter {
  const maxReported =
    options?.maxReported ?? MAX_REPORTED_UNRECOGNIZED_ENTRYPOINTS;
  // Rendered-at-insertion, per ISS-6576: an arbitrarily long raw value must not
  // be the thing pinned in memory for the life of the process.
  const reported = new Set<string>();
  let overflowAnnounced = false;
  return {
    note(entrypoint) {
      // Narrowed here rather than cast after the classify call: only a stated,
      // non-empty string can classify unrecognized, and the type system cannot
      // read that out of the returned member.
      if (typeof entrypoint !== "string" || entrypoint === "") {
        return;
      }
      if (
        classifyEntrypoint(entrypoint) !==
        EntrypointClass.UnrecognizedInteractive
      ) {
        return;
      }
      // whitlockk review: this string is harness-controlled and its destination is
      // the PERSISTENT desktop main.log, so a malformed transcript stamping a
      // credential into `entrypoint` would durably write it to disk.
      // `renderDiagnosticName` escapes and caps — neither of which removes a
      // secret — so the value goes through the canonical redactor first.
      //
      // Redacted BEFORE lowercasing, and that order is load-bearing rather than
      // incidental: several families in the vocabulary are matched at their
      // documented casing (`AKIA…`, `AIza…`, `SG.…`, and the `eyJ` JWT prefix),
      // so lowercasing first would hand the log exactly the bytes this call
      // exists to remove. Redacted BEFORE rendering for the same reason the
      // caller cannot do it after: rendering caps at 120 characters, which
      // truncates a token rather than removing it.
      const rendered = renderDiagnosticName(redactSecrets(entrypoint));
      // Compared lowercased, matching `classifyEntrypoint`: `Codex Desktop` and
      // `codex desktop` are one value to the classifier, so they are one report
      // here too rather than two lines describing the same drift. Lowercasing
      // the RENDERED form keeps the emitted line at its original casing, so a
      // `[REDACTED:…]` marker reads as the canonical marker rather than a
      // lowercased near-miss of one. Two distinct secrets of the same family
      // collapse to one key, which only tightens the bound below.
      const key = rendered.toLowerCase();
      if (reported.has(key)) {
        return;
      }
      if (reported.size >= maxReported) {
        if (overflowAnnounced) {
          return;
        }
        overflowAnnounced = true;
        return `Unrecognized session entrypoints: past the ${maxReported}-value cap; further unrecognized values will not be reported`;
      }
      reported.add(key);
      return `Unrecognized session entrypoint ${rendered}: classified INTERACTIVE by default (no headless prefix or token matched). If this launcher is autonomous, its injected prompts are being counted as human turns`;
    },
  };
}
