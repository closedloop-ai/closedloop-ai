/**
 * Fixture support for ISS-5872 — "completed" must mean "produced".
 *
 * A fake harness that exits 0 stands for a run that succeeded, and a successful
 * PLAN/DECOMPOSE/GENERATE_PRD/EVALUATE_* run always writes its deliverable.
 * Once the finalizer refuses to complete a loop whose required artifact is
 * missing, a fixture that skips that write fails for a reason its test is not
 * about, so these helpers make the fixtures honest in one place.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Matches the shebang the artifact fragment is injected after. */
export const SHEBANG_LINE = /^(#!\/bin\/sh\n)/;

/**
 * Shell fragment that writes the deliverable `$CLOSEDLOOP_COMMAND` owes, unless
 * the script under test already wrote one. Injected automatically by
 * `createFakeRunLoopScript`; fake `claude` binaries that stand in for the
 * NATIVE pipeline (which never invokes run-loop.sh) must include it themselves.
 * Mirrors `ResultBundle`'s
 * `enforceRequired` set (ISS-5872) — EXECUTE is deliberately absent, because
 * `execution-result.json` is written only after a real commit AND push and
 * several tests depend on its absence meaning "no changes".
 *
 * Each command writes to the directory the harness actually reads that command's
 * bundle from (`resolveArtifactOutputDir`): the PRD commands write `prd.md` into
 * the checkout they are spawned in — `$PWD` is the worktree for those — and
 * everything else writes into `$CLOSEDLOOP_WORKDIR`. Writing to the wrong one
 * would make the fixture stand for a run that produced nothing uploadable.
 */
export const WRITE_REQUIRED_ARTIFACT_SH = [
  'mkdir -p "$CLOSEDLOOP_WORKDIR" 2>/dev/null',
  '__cl_dir="$CLOSEDLOOP_WORKDIR"',
  'case "$CLOSEDLOOP_COMMAND" in',
  '  PLAN|REQUEST_CHANGES) __cl_artifact=plan.json; __cl_body=\'{"content":"fixture plan","tasks":[]}\' ;;',
  "  DECOMPOSE) __cl_artifact=features.json; __cl_body='{\"features\":[]}' ;;",
  "  GENERATE_PRD|REQUEST_PRD_CHANGES) __cl_dir=\"$PWD\"; __cl_artifact=prd.md; __cl_body='# Fixture PRD' ;;",
  "  EVALUATE_PRD) __cl_artifact=prd-judges.json; __cl_body='{}' ;;",
  "  EVALUATE_PLAN) __cl_artifact=plan-judges.json; __cl_body='{}' ;;",
  "  EVALUATE_CODE) __cl_artifact=code-judges.json; __cl_body='{}' ;;",
  "  EVALUATE_FEATURE) __cl_artifact=feature-judges.json; __cl_body='{}' ;;",
  "  *) __cl_artifact= ;;",
  "esac",
  'if [ -n "$__cl_artifact" ] && [ ! -s "$__cl_dir/$__cl_artifact" ]; then',
  '  mkdir -p "$__cl_dir" 2>/dev/null',
  '  printf %s "$__cl_body" > "$__cl_dir/$__cl_artifact"',
  "fi",
  "",
].join("\n");

/**
 * Write a fake `claude` binary that stands in for the NATIVE prompt pipeline.
 *
 * That pipeline never invokes run-loop.sh, so `createFakeRunLoopScript`'s
 * artifact injection cannot reach it. Routing these fixtures through one helper
 * keeps "a fake harness that exits 0 wrote the deliverable it owes" true on
 * both pipelines (ISS-5872), instead of leaving it to each call site.
 */
export async function writeFakeClaudeScript(
  binDir: string,
  scriptContent: string
): Promise<string> {
  const scriptPath = path.join(binDir, "claude");
  await fs.writeFile(
    scriptPath,
    scriptContent.replace(SHEBANG_LINE, `$1${WRITE_REQUIRED_ARTIFACT_SH}`),
    { mode: 0o755 }
  );
  return scriptPath;
}
