/**
 * Tests for codex/argue and review-findings write-convergence fix.
 *
 * The fix: reads use findFirstExistingPath (old then new), while writes
 * always target .closedloop-ai/work. This ensures that state written at
 * .claude/work (legacy) is visible for reads, but all new writes land in
 * the canonical .closedloop-ai/work location.
 *
 * We test the split-path functions inline since the route handlers are not
 * exported. The logic exactly mirrors what the route files implement.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findFirstExistingPath } from "@/lib/engineer/process-utils";

/** Read debate state: checks new path first then legacy. */
function getDebateStateReadPath(worktreeDir: string): string | null {
  return findFirstExistingPath(
    join(worktreeDir, ".closedloop-ai", "work", "codex-debate.json"),
    join(worktreeDir, ".claude", "work", "codex-debate.json")
  );
}

/** Write debate state: always targets new canonical path. */
function getDebateStateWritePath(worktreeDir: string): string {
  return join(worktreeDir, ".closedloop-ai", "work", "codex-debate.json");
}

/** Read findings: checks new path first then legacy. */
function getFindingsReadPath(
  worktreeDir: string,
  provider: string
): string | null {
  return findFirstExistingPath(
    join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      `review-findings-${provider}.json`
    ),
    join(worktreeDir, ".claude", "work", `review-findings-${provider}.json`)
  );
}

/** Write findings: always targets new canonical path. */
function getFindingsWritePath(worktreeDir: string, provider: string): string {
  return join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    `review-findings-${provider}.json`
  );
}

describe("codex/argue debate state — read from legacy, write to new", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "codex-write-convergence-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reads debate state from .claude/work when .closedloop-ai/work has no state", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    const legacyDebate = { sessionId: "sess-abc", rounds: 3 };
    writeFileSync(
      join(legacyWorkDir, "codex-debate.json"),
      JSON.stringify(legacyDebate)
    );

    // New dir exists but no debate file there
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });

    const readPath = getDebateStateReadPath(testDir);
    expect(readPath).not.toBeNull();
    expect(readPath).toContain(".claude");

    const data = JSON.parse(readFileSync(readPath!, "utf-8"));
    expect(data.sessionId).toBe("sess-abc");
    expect(data.rounds).toBe(3);
  });

  it("writes debate state to .closedloop-ai/work regardless of where legacy state lives", () => {
    // Legacy has state
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "codex-debate.json"),
      JSON.stringify({ sessionId: "old-sess", rounds: 1 })
    );

    // Perform write to canonical path
    const writePath = getDebateStateWritePath(testDir);
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    const updatedState = { sessionId: "new-sess", rounds: 2 };
    writeFileSync(writePath, JSON.stringify(updatedState));

    // Write path must be in new dir
    expect(writePath).toContain(".closedloop-ai");
    expect(existsSync(writePath)).toBe(true);

    // New dir now has the updated state
    const written = JSON.parse(readFileSync(writePath, "utf-8"));
    expect(written.sessionId).toBe("new-sess");
    expect(written.rounds).toBe(2);

    // Legacy file remains untouched
    const legacy = JSON.parse(
      readFileSync(join(legacyWorkDir, "codex-debate.json"), "utf-8")
    );
    expect(legacy.sessionId).toBe("old-sess");
  });

  it("reads debate state from .closedloop-ai/work when it exists there", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(
      join(newWorkDir, "codex-debate.json"),
      JSON.stringify({ sessionId: "new-sess", rounds: 5 })
    );

    const readPath = getDebateStateReadPath(testDir);
    expect(readPath).not.toBeNull();
    expect(readPath).toContain(".closedloop-ai");

    const data = JSON.parse(readFileSync(readPath!, "utf-8"));
    expect(data.sessionId).toBe("new-sess");
  });
});

describe("review-findings — read from legacy, write to new", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "review-findings-convergence-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reads findings from .claude/work when .closedloop-ai/work has no findings file", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    const legacyFindings = {
      provider: "codex",
      model: "o4-mini",
      findings: [{ message: "bug", commented: false }],
    };
    writeFileSync(
      join(legacyWorkDir, "review-findings-codex.json"),
      JSON.stringify(legacyFindings)
    );

    // New dir exists but no findings file there
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });

    const readPath = getFindingsReadPath(testDir, "codex");
    expect(readPath).not.toBeNull();
    expect(readPath).toContain(".claude");

    const data = JSON.parse(readFileSync(readPath!, "utf-8"));
    expect(data.findings).toHaveLength(1);
  });

  it("writes findings to .closedloop-ai/work when reading from legacy path", () => {
    // Legacy has findings
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "review-findings-codex.json"),
      JSON.stringify({
        provider: "codex",
        model: "o4-mini",
        findings: [{ message: "old", commented: false }],
      })
    );

    // Write always goes to new canonical path
    const writePath = getFindingsWritePath(testDir, "codex");
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    const newFindings = {
      provider: "codex",
      model: "o4-mini",
      findings: [{ message: "updated", commented: true }],
    };
    writeFileSync(writePath, JSON.stringify(newFindings));

    // Write path is in new dir
    expect(writePath).toContain(".closedloop-ai");
    expect(existsSync(writePath)).toBe(true);

    const written = JSON.parse(readFileSync(writePath, "utf-8"));
    expect(written.findings[0].message).toBe("updated");
    expect(written.findings[0].commented).toBe(true);
  });

  it("write path uses correct provider suffix for claude", () => {
    const writePath = getFindingsWritePath(testDir, "claude");
    expect(writePath).toContain("review-findings-claude.json");
    expect(writePath).toContain(".closedloop-ai");
  });
});
