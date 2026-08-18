/**
 * Codex driver. Verbatim invocation from the legacy bash.
 *
 * `codex exec` is a ONE-SHOT: there is no long-lived codex scheduler process and
 * no local scheduled-task store to register into, so codex has no native-local
 * scheduling target (FEA-4070). Its capability is `NativeSchedule.None` and it
 * stays daemon-scheduled (`TaskRoute.LocalCascade`) by design. This driver is the
 * cascade EXECUTION path (crewd runs a scheduled job THROUGH `codex exec`); it is
 * deliberately NOT a scheduling registrar.
 */
import { AVAILABLE_MODELS, DEFAULT_MODEL, HarnessName } from "../model.js";
import { HARNESS_CAPABILITIES } from "./capabilities.js";
import { inlineStdin, onPath, runProcess } from "./exec.js";
import type { Harness, RunOpts, RunResult } from "./types.js";

export const codexHarness: Harness = {
  name: HarnessName.Codex,
  capabilities: HARNESS_CAPABILITIES[HarnessName.Codex],

  isAvailable: () => onPath("codex"),

  listModels: () => Promise.resolve(AVAILABLE_MODELS[HarnessName.Codex]),

  run(opts: RunOpts): Promise<RunResult> {
    // codex exec --cd <cwd> -m <model> [--add-dir <dir>...] --skip-git-repo-check \
    //   --dangerously-bypass-approvals-and-sandbox -   < (prompt+files)
    const model = opts.model ?? DEFAULT_MODEL[HarnessName.Codex];
    const args = ["exec", "--cd", opts.cwd, "-m", model];
    for (const d of opts.addDirs ?? []) {
      args.push("--add-dir", d);
    }
    args.push(
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-"
    );
    return runProcess(
      { command: "codex", args, stdin: inlineStdin(opts.prompt, opts.files) },
      opts
    );
  },
};
