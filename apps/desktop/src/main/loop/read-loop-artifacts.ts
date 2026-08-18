/**
 * Per-command artifact reads for loop finalization.
 *
 * Extracted from `loop-finalizer.ts` (ISS-5872) so the finalizer keeps only
 * terminal-state decisions and this module owns "what did the run write, and
 * where". Both the live-exit and boot-recovery finalization paths read through
 * here, so a command whose artifact lands in the worktree rather than the
 * claude workdir is resolved identically on both.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  EVALUATE_COMMAND_ARTIFACT,
  readBootstrapOutputs,
  readEvaluateOutputs,
} from "../../server/operations/symphony-loop.js";
import {
  IMPORTED_PLAN_MARKDOWN_FILE,
  toUploadedPlanArtifact,
} from "../../shared/plan-artifact-utils.js";
import { readTextFile } from "../diagnostics/diagnostics-helpers.js";
import { resolveArtifactOutputDir } from "./artifact-output-dir.js";

function readJsonFileSync(filePath: string): unknown | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function readArtifacts(
  command: string,
  claudeWorkDir: string,
  worktreeDir?: string
): Record<string, unknown> {
  if (command === LoopCommand.Plan || command === LoopCommand.RequestChanges) {
    const plan = toUploadedPlanArtifact(
      readJsonFileSync(path.join(claudeWorkDir, "plan.json"))
    );
    const openQuestions = readTextFile(
      path.join(claudeWorkDir, "open-questions.md")
    );
    const judges = readJsonFileSync(path.join(claudeWorkDir, "judges.json"));
    return {
      plan: plan ?? undefined,
      openQuestions: openQuestions ?? undefined,
      judges: judges ?? undefined,
    };
  }
  if (command === LoopCommand.Execute) {
    const plan =
      toUploadedPlanArtifact(
        readJsonFileSync(path.join(claudeWorkDir, "plan.json"))
      ) ??
      toUploadedPlanArtifact(
        readTextFile(path.join(claudeWorkDir, IMPORTED_PLAN_MARKDOWN_FILE))
      );
    const executionResult = readJsonFileSync(
      path.join(claudeWorkDir, "execution-result.json")
    );
    const codeJudges = readJsonFileSync(
      path.join(claudeWorkDir, "code-judges.json")
    );
    return {
      plan: plan ?? undefined,
      executionResult: executionResult ?? undefined,
      codeJudges: codeJudges ?? undefined,
    };
  }
  if (command === LoopCommand.Decompose) {
    const features = readJsonFileSync(
      path.join(claudeWorkDir, "features.json")
    );
    return { features: features ?? undefined };
  }
  if (
    command === LoopCommand.EvaluatePrd ||
    command === LoopCommand.EvaluatePlan ||
    command === LoopCommand.EvaluateCode ||
    command === LoopCommand.EvaluateFeature
  ) {
    return readEvaluateOutputs(
      claudeWorkDir,
      EVALUATE_COMMAND_ARTIFACT[command]
    );
  }
  if (
    command === LoopCommand.GeneratePrd ||
    command === LoopCommand.RequestPrdChanges
  ) {
    // Both PRD commands write the (re)generated PRD to prd.md in the same
    // worktree. Live completion in handleProcessCompletion handles both via
    // the same dispatch (see symphony-loop.ts); boot recovery must mirror
    // that, otherwise a REQUEST_PRD_CHANGES loop finalized after an Electron
    // restart would silently lose the generated artifact. Both paths — and the
    // missing-artifact guard that decides whether the run produced anything —
    // resolve the directory through the same helper so they cannot drift.
    const baseDir = resolveArtifactOutputDir(command, {
      claudeWorkDir,
      worktreeDir,
    });
    const prdContent = readTextFile(path.join(baseDir, "prd.md"));
    return { prd: prdContent ? { content: prdContent } : undefined };
  }
  if (command === LoopCommand.Bootstrap) {
    return readBootstrapOutputs(claudeWorkDir);
  }
  return {};
}
