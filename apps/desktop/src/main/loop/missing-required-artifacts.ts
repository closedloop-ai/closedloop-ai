/**
 * ISS-5872 — "completed" must mean "produced".
 *
 * A loop that exits 0 without writing the artifact it exists to produce used to
 * finalize as COMPLETED with `error: null`. The harness already DETECTED the
 * gap — `validateResultBundle` was called, the result logged as a warning, and
 * then discarded — so terminality was decided purely from the absence of an
 * exception. Observed live on loop 019fee5a (PLAN against PLN-1688): the plan
 * writer was still running in the background when the loop ended, no plan.json
 * was ever written, and the artifact presented as done-and-empty.
 *
 * This module turns that detection into the load-bearing signal. It reports
 * WHICH files a run owed and did not write, so the failure can name them
 * instead of raising a generic error from an anonymous inner frame.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  findUnproducedRequiredArtifacts,
  missingRequiredArtifactsMessage,
  ResultBundle,
} from "@closedloop-ai/loops-api/bundles";
import type { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { LocalJob } from "../jobs/job-store.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  type LoopArtifactDirs,
  resolveArtifactOutputDir,
} from "./artifact-output-dir.js";

/**
 * A required artifact counts as produced only when it has content. The live
 * incident left PLN-1688 "at version 1 with 0 bytes", so an empty file is the
 * same failure wearing a different hat — it would satisfy a bare existence
 * check and hand the operator a done-and-empty artifact.
 *
 * A non-empty file can still be unusable, which is why the JSON deliverables
 * are additionally required to PARSE. Every reader of a `*.json` bundle file —
 * `readArtifacts`, `readDecomposeOutputs`, `readEvaluateOutputs` — funnels
 * through a `JSON.parse` that swallows its error and yields nothing, so a
 * truncated `plan.json` uploads no plan at all; treating it as produced would
 * hand back the same done-and-empty artifact by a different route. The
 * markdown deliverable (`prd.md`) has no parse step, so content is the whole
 * contract there.
 */
function isProducedArtifactFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!(stat.isFile() && stat.size > 0)) {
      return false;
    }
    if (path.extname(filePath) !== ".json") {
      return true;
    }
    return JSON.parse(readFileSync(filePath, "utf-8")) !== null;
  } catch {
    return false;
  }
}

/**
 * Required artifacts the command owed and did not write.
 *
 * Looks in exactly one directory — the one the uploader reads this command's
 * result bundle from, per `resolveArtifactOutputDir`. Searching both candidate
 * directories would let a same-named file elsewhere in the repo checkout count
 * as produced for a run whose output directory is empty, so the loop would
 * upload nothing and still complete.
 *
 * Returns `[]` for commands whose manifest is not enforced — see
 * `ResultBundle[…].enforceRequired`. EXECUTE is the notable exclusion: its
 * `execution-result.json` is written only after a successful commit AND push,
 * so a legitimate no-changes run ends without it.
 */
export function findMissingRequiredArtifacts(
  command: string,
  dirs: LoopArtifactDirs
): string[] {
  const manifest = ResultBundle[command as LoopCommand];
  if (!manifest?.enforceRequired) {
    return [];
  }
  const outputDir = resolveArtifactOutputDir(command, dirs);
  // The output directory is gone, so the evidence cannot be read at all. That
  // is NOT the same as "the run produced nothing": live-exit deletes the temp
  // workdir (DECOMPOSE, EVALUATE_*) and removes the worktree (the PRD commands)
  // right after finalization, so a boot-recovery replay of a run whose
  // completed event merely failed to POST would otherwise re-adjudicate a
  // genuine success as FAILED — and report a missing artifact the cloud is
  // already holding. Absence of evidence is not evidence of absence; fail open
  // in the one case that is provably unknowable.
  if (!(outputDir && existsSync(outputDir))) {
    return [];
  }
  const presentFiles = manifest.required.filter((file) =>
    isProducedArtifactFile(path.join(outputDir, file))
  );
  return findUnproducedRequiredArtifacts(command, presentFiles);
}

/**
 * Downgrade a would-be-success whose deliverable was never written.
 *
 * Only inspects would-be-successes: a job already FAILED/STOPPED/CANCELLED has
 * a real terminal reason of its own and keeps it rather than being relabelled
 * by its empty bundle.
 *
 * `finalStatusPersistedAt` gates this to the FIRST adjudication. A retry pass
 * is re-posting a terminal decision that was already made while the artifacts
 * were still on disk; re-deciding it after cleanup has run would flip a genuine
 * success to FAILED purely because the workdir is gone.
 *
 * Returns the job unchanged when there is nothing to downgrade.
 */
export function downgradeJobForMissingArtifacts(
  job: LocalJob,
  context: LoopArtifactDirs & { reason: string }
): LocalJob {
  if (
    job.finalStatusPersistedAt ||
    !(job.status === "COMPLETED" || job.status === "RUNNING")
  ) {
    return job;
  }
  const command = String(job.command);
  const missingArtifacts = findMissingRequiredArtifacts(command, context);
  if (missingArtifacts.length === 0) {
    return job;
  }
  gatewayLog.error(
    "loop-finalizer",
    `${missingRequiredArtifactsMessage(command, missingArtifacts)}, loopId=${job.loopId}, reason=${context.reason}`
  );
  return {
    ...job,
    status: "FAILED",
    exitCode: job.exitCode ?? 0,
    missingRequiredArtifacts: missingArtifacts,
  };
}
