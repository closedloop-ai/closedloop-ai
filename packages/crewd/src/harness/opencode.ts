/** Opencode driver. Verbatim invocation from the legacy bash. */
import { AVAILABLE_MODELS, DEFAULT_MODEL, HarnessName } from "../model.js";
import { HARNESS_CAPABILITIES } from "./capabilities.js";
import { onPath, runProcess } from "./exec.js";
import type { Harness, RunOpts, RunResult } from "./types.js";

export const opencodeHarness: Harness = {
  name: HarnessName.Opencode,
  capabilities: HARNESS_CAPABILITIES[HarnessName.Opencode],

  isAvailable: () => onPath("opencode"),

  listModels: () => Promise.resolve(AVAILABLE_MODELS[HarnessName.Opencode]),

  run(opts: RunOpts): Promise<RunResult> {
    // opencode run --dir <cwd> --model <model> "<prompt>" --file <file>...
    // Unlike claude/codex, opencode takes the prompt as an arg and real --file flags.
    const model = opts.model ?? DEFAULT_MODEL[HarnessName.Opencode];
    const args = ["run", "--dir", opts.cwd, "--model", model, opts.prompt];
    for (const f of opts.files ?? []) {
      args.push("--file", f);
    }
    return runProcess({ command: "opencode", args, stdin: "" }, opts);
  },
};
