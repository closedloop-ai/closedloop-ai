import { describe, expect, it } from "vitest";
import {
  assemblePromptBundle,
  buildRuntimeContext,
} from "../src/passes/prompt-bundle.js";

describe("assemblePromptBundle", () => {
  it("orders shared prompts, character prompt, then runtime context", () => {
    const out = assemblePromptBundle({
      characterPrompt: "CHARACTER",
      sharedPrompts: ["SHARED_A", "SHARED_B"],
      runtimeContext: "RUNTIME",
    });
    const iA = out.indexOf("SHARED_A");
    const iC = out.indexOf("CHARACTER");
    const iR = out.indexOf("RUNTIME");
    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iA).toBeLessThan(iC);
    expect(iC).toBeLessThan(iR);
  });

  it("applies substitutions across the whole bundle", () => {
    const out = assemblePromptBundle({
      characterPrompt: "path is SCRATCH_PROMPT_PATH here",
      sharedPrompts: ["repo at SCRATCH_REPO_DIR"],
      substitutions: { SCRATCH_PROMPT_PATH: "/p/x.md", SCRATCH_REPO_DIR: "/r" },
    });
    expect(out).toContain("/p/x.md");
    expect(out).toContain("/r");
    expect(out).not.toContain("SCRATCH_PROMPT_PATH");
    expect(out).not.toContain("SCRATCH_REPO_DIR");
  });
});

describe("buildRuntimeContext", () => {
  it("includes findings paths and hot-spot files, and the clock when bounded", () => {
    const ctx = buildRuntimeContext({
      repoDir: "/repo",
      findingsJsonlPath: "/w/.nightly-review/findings.jsonl",
      findingsTxtPath: "/w/.nightly-review/carl-findings.txt",
      recentlyChangedFiles: ["a.ts", "b.ts"],
      clock: { nowSec: 100, softSec: 200, hardSec: 300 },
    });
    expect(ctx).toContain("findings.jsonl");
    expect(ctx).toContain("- a.ts");
    expect(ctx).toContain("SOFT deadline=200");
    expect(ctx).toContain("LAND THE PLANE");
  });

  it("omits the clock block when unbounded", () => {
    const ctx = buildRuntimeContext({
      repoDir: "/repo",
      findingsJsonlPath: "/w/f.jsonl",
      findingsTxtPath: "/w/f.txt",
    });
    expect(ctx).not.toContain("RUNTIME CLOCK");
  });

  it("tells the reviewer where a prior run stopped so it resumes rather than repeats", () => {
    // Without this the next run re-reviews ground the last one already covered,
    // which is the whole point of the rolling `covered` marker.
    const ctx = buildRuntimeContext({
      repoDir: "/repo",
      findingsJsonlPath: "/w/f.jsonl",
      findingsTxtPath: "/w/f.txt",
      priorCovered: "src/a.ts through src/m.ts",
    });

    expect(ctx).toContain("Prior run covered: src/a.ts through src/m.ts");
    expect(ctx).toContain("resume beyond it");
  });

  it("omits the prior-covered line entirely on a first run", () => {
    const ctx = buildRuntimeContext({
      repoDir: "/repo",
      findingsJsonlPath: "/w/f.jsonl",
      findingsTxtPath: "/w/f.txt",
    });

    expect(ctx).not.toContain("Prior run covered");
  });
});

describe("assemblePromptBundle shared prompts", () => {
  it("prepends each shared prompt ahead of the character prompt, in order", () => {
    const out = assemblePromptBundle({
      characterPrompt: "CHARACTER",
      sharedPrompts: ["SHARED-ONE", "SHARED-TWO"],
    });

    expect(out.indexOf("SHARED-ONE")).toBeLessThan(out.indexOf("SHARED-TWO"));
    expect(out.indexOf("SHARED-TWO")).toBeLessThan(out.indexOf("CHARACTER"));
  });

  it("emits just the character prompt when no shared prompts are supplied", () => {
    expect(assemblePromptBundle({ characterPrompt: "CHARACTER" })).toBe(
      "CHARACTER"
    );
  });
});
