/** Claude Code driver. Verbatim invocation from the legacy bash. */
import { AVAILABLE_MODELS, DEFAULT_MODEL, HarnessName } from "../model.js";
import { HARNESS_CAPABILITIES } from "./capabilities.js";
import { inlineStdin, onPath, runProcess } from "./exec.js";
import type { Harness, RunOpts, RunResult } from "./types.js";

export const claudeHarness: Harness = {
  name: HarnessName.Claude,
  // Claude Code has a native scheduler (scheduled_tasks.json / cloud routines),
  // so the broker MAY hand it a schedule when a live session is present.
  capabilities: HARNESS_CAPABILITIES[HarnessName.Claude],

  isAvailable: () => onPath("claude"),

  listModels: () => Promise.resolve(AVAILABLE_MODELS[HarnessName.Claude]),

  run(opts: RunOpts): Promise<RunResult> {
    // claude --print --dangerously-skip-permissions --model <model> --add-dir <dir>...  < (prompt+files)
    const model = opts.model ?? DEFAULT_MODEL[HarnessName.Claude];
    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--model",
      model,
    ];
    for (const d of opts.addDirs ?? [opts.cwd]) {
      args.push("--add-dir", d);
    }
    return runProcess(
      { command: "claude", args, stdin: inlineStdin(opts.prompt, opts.files) },
      opts
    );
  },
};
