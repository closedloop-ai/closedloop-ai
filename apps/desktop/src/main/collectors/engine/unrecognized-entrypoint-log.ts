/**
 * @file unrecognized-entrypoint-log.ts
 * @description ISS-7260: the process-wide reporter for session entrypoints the
 * headless classifier does not recognise, and the one place both parse paths
 * call into.
 *
 * whitlockk review: this began inside `collector-manager-source-parse.ts`, under a
 * comment claiming that step was "the one place every harness's parse resolves
 * through". It is not. The DATA_REVISION rebuild parses through
 * `data-revision-rebuild.ts` via `collector.parse(source)` and never reaches the
 * import step, so a boot that rebuilt a stale cohort could re-derive and write
 * sessions carrying an unrecognized entrypoint while the log stayed silent —
 * and a rebuild is exactly when a harness rename gets applied to a whole corpus
 * at once. Both paths report now.
 *
 * They share ONE reporter rather than owning an instance each, which is the
 * point of putting it here: "once per distinct value" and the retention cap are
 * only worth stating if they hold across the import pass and the rebuild
 * together. Two instances would re-report every value the other had already
 * named and double the ceiling.
 *
 * Advisory on both paths, exactly as before: an unrecognized entrypoint still
 * classifies interactive, and nothing here changes what is written. It exists so
 * a silent upstream rename is audible before its reclassification shows up as a
 * moved chart.
 */
import { createUnrecognizedEntrypointReporter } from "@repo/lib/session-trace/headless-entrypoint-drift";
import type { NormalizedSession } from "../types.js";

const reporter = createUnrecognizedEntrypointReporter();

/**
 * Report every unrecognized entrypoint in `sessions`, once per distinct value
 * for the life of this process. Silent for a recognized value, an absent one, a
 * repeat, and anything past the reporter's cap.
 */
export function reportUnrecognizedEntrypoints(
  sessions: readonly NormalizedSession[],
  log: (message: string) => void
): void {
  for (const session of sessions) {
    const line = reporter.note(session.entrypoint);
    if (line !== undefined) {
      log(line);
    }
  }
}
