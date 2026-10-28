/**
 * @file onboarding-parse-progress.ts
 * @description ISS-8346 — read the boot import as the analysis estimate needs
 * it: how many bytes are still to parse, and what the parser is doing.
 *
 * A MODULE RATHER THAN A LAMBDA AT THE COMPOSITION ROOT, for the reason
 * `onboarding-local-state-source.ts` states about its own seams: a branch
 * inlined in the runtime factory is readable and not executable, and every
 * branch here is one an ordinary machine takes — nothing measured yet, the pass
 * mid-flight, the pass finished, the import parked by the user.
 */

import { AnalysisParserActivity } from "../../shared/transcript-analysis-eta-contract.js";
import type { IngestProgressReport } from "../collectors/engine/collector-manager-ingest-progress.js";

export type OnboardingParseProgressReading = {
  /**
   * Bytes the import still has to parse for the harnesses asked about, or `null`
   * when no honest number can be stated.
   *
   * `null` is not an error and not zero. Before the collectors have opened a
   * pass there is nothing measured, and answering 0 there would tell the
   * estimate the corpus is already parsed — a claim its high-water mark then
   * holds for the life of the process, so the first launch it was built for
   * would render as instantly complete.
   */
  remainingBytes: number | null;
  activity: AnalysisParserActivity;
};

export type OnboardingParseProgressInput = {
  /**
   * The FULL manager report, not the renderer's `DesktopIngestProgressReport`.
   * The pause and retries-exhausted facts the activity below turns on are
   * main-only and deliberately absent from that wire shape, so this reading is
   * assembled where the manager is — inside the dashboard runtime.
   */
  report: IngestProgressReport;
  /** `CollectorManager.remainingPendingBytes` over the inventory's harnesses. */
  remainingPendingBytes: number | null;
};

/**
 * What to answer when there is no collector manager to ask — before the
 * dashboard runtime is composed, and after a failed boot leaves it absent.
 *
 * `Running` beside a `null` remainder is not a claim that anything is running:
 * the estimate reads the byte state first and withdraws to
 * `progress-indeterminate` on the missing remainder, so the activity never
 * decides anything here. Saying `Failed` instead would report a lane that has
 * not started as one that gave up.
 */
export const PARSE_PROGRESS_UNMEASURED: OnboardingParseProgressReading = {
  activity: AnalysisParserActivity.Running,
  remainingBytes: null,
};

export function readOnboardingParseProgress(
  input: OnboardingParseProgressInput
): OnboardingParseProgressReading {
  const { report } = input;
  return {
    activity: resolveActivity(report),
    remainingBytes: resolveRemainingBytes(report, input.remainingPendingBytes),
  };
}

/**
 * The three lifecycle facts the report carries are DISTINCT claims, so they are
 * read in the order the estimate treats them: a degraded terminal outranks a
 * pause, because a lane that gave up is not a lane a user can resume, and the
 * estimate refuses to keep counting down for either.
 *
 * `Stalled` is deliberately absent — the estimate derives that from measured
 * silence, and a wedged import is exactly the one that cannot report itself.
 */
function resolveActivity(report: IngestProgressReport): AnalysisParserActivity {
  if (report.timedOut || report.retriesExhausted) {
    return AnalysisParserActivity.Failed;
  }
  if (report.importParked) {
    return AnalysisParserActivity.Paused;
  }
  return AnalysisParserActivity.Running;
}

function resolveRemainingBytes(
  report: IngestProgressReport,
  remainingPendingBytes: number | null
): number | null {
  if (remainingPendingBytes !== null) {
    return remainingPendingBytes;
  }
  // Nothing measured. Only a COMPLETED boot import turns that into "there was
  // nothing to parse" — the already-imported machine, where no pass is opened
  // because no source is pending. Before it completes the same silence means the
  // collectors have not got there yet, and a source scan still running (which
  // reports `preparing`) is the loudest case of it.
  if (report.complete && !report.preparing) {
    return 0;
  }
  return null;
}
