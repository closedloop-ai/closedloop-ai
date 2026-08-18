/**
 * @file harness-drivers.test.ts
 * @description The three concrete drivers wired into `defaultRegistry`
 * (ISS-5296). Every cascade run — audit pass, custom task, CLI daemon — spawns one
 * of these, and each spawns its engine with a dangerous-permission bypass
 * (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`).
 * The argv is therefore a real contract, not an implementation detail: a dropped
 * `--model` silently runs the wrong (and differently-priced) model, and a dropped
 * `--add-dir` silently denies the harness the directory it was asked to work in.
 *
 * `./exec.js` is mocked, so no process is ever spawned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunOpts, RunResult } from "../src/harness/types.js";
import { DEFAULT_MODEL, HarnessName } from "../src/model.js";

const runProcess = vi.hoisted(() => vi.fn());
const inlineStdin = vi.hoisted(() => vi.fn(() => "STDIN"));
const onPath = vi.hoisted(() =>
  vi.fn((_command: string) => Promise.resolve(true))
);

vi.mock("../src/harness/exec.js", () => ({ runProcess, inlineStdin, onPath }));

const { claudeHarness } = await import("../src/harness/claude.js");
const { codexHarness } = await import("../src/harness/codex.js");
const { opencodeHarness } = await import("../src/harness/opencode.js");

const RESULT = {} as RunResult;

/** The argv the driver handed to `runProcess` for a given `RunOpts`. */
function argvFor(
  harness: { run: (o: RunOpts) => Promise<RunResult> },
  opts: Partial<RunOpts> = {}
): string[] {
  harness.run({ prompt: "p", cwd: "/repo", ...opts });
  const spec = runProcess.mock.calls.at(-1)?.[0] as {
    command: string;
    args: string[];
  };
  return [spec.command, ...spec.args];
}

beforeEach(() => {
  runProcess.mockReset().mockReturnValue(Promise.resolve(RESULT));
  inlineStdin.mockClear();
});

describe("claudeHarness.run argv", () => {
  it("threads an explicit model into --model", () => {
    expect(argvFor(claudeHarness, { model: "opus" })).toContain("opus");
    expect(argvFor(claudeHarness, { model: "opus" })).toEqual(
      expect.arrayContaining(["--model", "opus"])
    );
  });

  it("falls back to the harness default model when none is given", () => {
    expect(argvFor(claudeHarness)).toEqual(
      expect.arrayContaining(["--model", DEFAULT_MODEL[HarnessName.Claude]])
    );
  });

  it("passes each explicit addDir through as its own --add-dir", () => {
    const argv = argvFor(claudeHarness, { addDirs: ["/a", "/b"] });
    expect(argv).toEqual(expect.arrayContaining(["--add-dir", "/a"]));
    expect(argv).toEqual(expect.arrayContaining(["--add-dir", "/b"]));
    expect(argv.filter((a) => a === "--add-dir")).toHaveLength(2);
  });

  it("defaults addDirs to the working directory", () => {
    // Claude alone defaults to `[cwd]` — without it the harness could not read the
    // repo it was pointed at.
    expect(argvFor(claudeHarness)).toEqual(
      expect.arrayContaining(["--add-dir", "/repo"])
    );
  });

  it("keeps the dangerous-permission bypass it needs to run unattended", () => {
    expect(argvFor(claudeHarness)).toContain("--dangerously-skip-permissions");
  });

  it("feeds prompt and files through the shared stdin inliner", () => {
    claudeHarness.run({ prompt: "p", cwd: "/repo", files: ["/f.txt"] });
    expect(inlineStdin).toHaveBeenCalledWith("p", ["/f.txt"]);
  });
});

describe("codexHarness.run argv", () => {
  it("threads an explicit model into -m", () => {
    expect(argvFor(codexHarness, { model: "o3" })).toEqual(
      expect.arrayContaining(["-m", "o3"])
    );
  });

  it("falls back to the harness default model when none is given", () => {
    expect(argvFor(codexHarness)).toEqual(
      expect.arrayContaining(["-m", DEFAULT_MODEL[HarnessName.Codex]])
    );
  });

  it("passes each explicit addDir through as its own --add-dir", () => {
    const argv = argvFor(codexHarness, { addDirs: ["/a", "/b"] });
    expect(argv.filter((a) => a === "--add-dir")).toHaveLength(2);
  });

  it("emits NO --add-dir when none is given (it does not default to cwd)", () => {
    // Deliberately unlike claude: codex already receives the working directory via
    // `--cd`, so its addDirs fallback is `[]`. Asserting a cwd default here would
    // encode a contract the driver does not have.
    expect(argvFor(codexHarness)).not.toContain("--add-dir");
    expect(argvFor(codexHarness)).toEqual(
      expect.arrayContaining(["--cd", "/repo"])
    );
  });

  it("keeps the sandbox bypass and reads the prompt from stdin", () => {
    const argv = argvFor(codexHarness);
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv.at(-1)).toBe("-");
  });
});

describe("opencodeHarness.run argv", () => {
  it("threads an explicit model into --model", () => {
    expect(argvFor(opencodeHarness, { model: "sonnet" })).toEqual(
      expect.arrayContaining(["--model", "sonnet"])
    );
  });

  it("falls back to the harness default model when none is given", () => {
    expect(argvFor(opencodeHarness)).toEqual(
      expect.arrayContaining(["--model", DEFAULT_MODEL[HarnessName.Opencode]])
    );
  });

  it("takes the prompt as an ARGUMENT, not on stdin", () => {
    // Unlike claude/codex, opencode receives the prompt positionally and gets an
    // empty stdin payload.
    opencodeHarness.run({ prompt: "the prompt", cwd: "/repo" });
    const spec = runProcess.mock.calls.at(-1)?.[0] as {
      args: string[];
      stdin: string;
    };
    expect(spec.args).toContain("the prompt");
    expect(spec.stdin).toBe("");
  });

  it("passes attached files as real --file flags", () => {
    const argv = argvFor(opencodeHarness, { files: ["/a.ts", "/b.ts"] });
    expect(argv.filter((a) => a === "--file")).toHaveLength(2);
    expect(argv).toEqual(expect.arrayContaining(["--file", "/a.ts"]));
  });

  it("emits no --file when none are attached", () => {
    expect(argvFor(opencodeHarness)).not.toContain("--file");
  });
});

describe("driver availability probes", () => {
  it("each driver probes PATH for its own binary", async () => {
    onPath.mockClear();
    await claudeHarness.isAvailable();
    await codexHarness.isAvailable();
    await opencodeHarness.isAvailable();
    expect(onPath.mock.calls.map((c) => c[0])).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
  });
});
