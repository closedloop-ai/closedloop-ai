/**
 * Review-pass orchestration, ported from `symphony-nightly-review`. Non-LLM work
 * (prompt assembly, findings parse, dedup, ClosedLoop issue authoring) lives here
 * in TS; the LLM step delegates to the cascade so any harness can run the pass.
 * Returns a DispatchOutcome so the daemon can schedule it directly.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClosedLoopClient } from "../clients/closedloop.js";
import { runCascade } from "../harness/cascade.js";
import type { HarnessRegistry } from "../harness/index.js";
import type { ScheduledTask } from "../model.js";
import type { DispatchContext, DispatchOutcome } from "../scheduler/daemon.js";
import { fileFindings, parseFindingsJsonl } from "./findings.js";
import { assemblePromptBundle, buildRuntimeContext } from "./prompt-bundle.js";
import { recentlyChangedFiles } from "./repo.js";

export type ReviewDeps = {
  closedloop: ClosedLoopClient;
  /** Absolute path to the repo the pass reviews. */
  repoDir: string;
  /** Directory holding `<pass>.md` character prompts. */
  promptsDir: string;
  /** Shared infra prompt file paths (cross-reference.md, …), prepended in order. */
  sharedPromptPaths?: string[];
  /** ClosedLoop assignee (crew manager) for filed issues. */
  assigneeId?: string;
  /** Per-attempt harness timeout (ms); 0/undefined = unbounded. */
  perAttemptTimeoutMs?: number;
  registry?: HarnessRegistry;
  /** Substitutions applied across the prompt bundle. */
  substitutions?: Record<string, string>;
};

export async function runReviewPass(
  task: ScheduledTask,
  ctx: DispatchContext,
  deps: ReviewDeps
): Promise<DispatchOutcome> {
  const pass = task.pass ?? task.name;
  const promptFile = join(deps.promptsDir, `${pass}.md`);
  if (!existsSync(promptFile)) {
    return fail(`character prompt not found: ${promptFile}`);
  }

  // 1. Work dir for findings output.
  const workDir = mkdtempSync(join(tmpdir(), `crewd-review-${pass}-`));
  const nrDir = join(workDir, ".nightly-review");
  mkdirSync(nrDir, { recursive: true });
  const findingsJsonl = join(nrDir, "findings.jsonl");
  const findingsTxt = join(nrDir, `${pass}-findings.txt`);

  // 2. Assemble the harness-neutral prompt bundle.
  const characterPrompt = readFileSync(promptFile, "utf8");
  const sharedPrompts = (deps.sharedPromptPaths ?? [])
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, "utf8"));
  const runtimeContext = buildRuntimeContext({
    repoDir: deps.repoDir,
    findingsJsonlPath: findingsJsonl,
    findingsTxtPath: findingsTxt,
    recentlyChangedFiles: await recentlyChangedFiles(deps.repoDir).catch(
      () => []
    ),
    priorCovered:
      typeof task.meta.covered === "string" ? task.meta.covered : null,
    focus: typeof task.meta.focus === "string" ? task.meta.focus : null,
  });
  const prompt = assemblePromptBundle({
    characterPrompt,
    sharedPrompts,
    runtimeContext,
    substitutions: deps.substitutions,
  });

  // 3. Run the analysis through the cascade.
  const cascade = task.harnessCascade.length
    ? task.harnessCascade
    : ctx.defaultCascade;
  const result = await runCascade({
    prompt,
    cwd: deps.repoDir,
    addDirs: [deps.repoDir, workDir],
    cascade,
    registry: deps.registry,
    // `undefined` ⇒ runCascade's bounded default (FEA-4012); explicit 0 stays
    // unbounded.
    perAttemptTimeoutMs: deps.perAttemptTimeoutMs,
    // FEA-4012: like the audit pass, the review runs non-interactively — a
    // harness that ends by asking a question can never be answered, so reject
    // the elicitation and cascade rather than reporting a false success.
    rejectElicitation: true,
  });

  // 4. Parse findings (present even if the run timed out mid-write).
  const findings = existsSync(findingsJsonl)
    ? parseFindingsJsonl(readFileSync(findingsJsonl, "utf8"))
    : [];
  if (findings.length === 0) {
    const status = result.ok ? "success" : "failed";
    return {
      status,
      harnessUsed: result.harnessUsed,
      attempts: result.attempts,
      summary: result.ok
        ? "clean — no findings"
        : "analysis failed, no findings",
      error: result.ok ? null : "cascade exhausted before findings",
    };
  }

  // 5. Author findings as TRIAGE issues, dedup-guarded (shared with M3).
  const filed = await fileFindings(deps.closedloop, findings, {
    tagName: `agent-${pass}`,
    assigneeId: deps.assigneeId,
  });

  return {
    status: "success",
    harnessUsed: result.harnessUsed,
    attempts: result.attempts,
    summary: `${filed.created} issue(s) filed, ${filed.skipped} deduped`,
    error: null,
  };
}

function fail(error: string): DispatchOutcome {
  return {
    status: "failed",
    harnessUsed: null,
    attempts: [],
    summary: error,
    error,
  };
}
