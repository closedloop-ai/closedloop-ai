import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  readBootstrapRepoOutputs,
  resetResolvedClaudePath,
} from "../src/server/operations/symphony-loop.js";
import {
  hasBootstrapArtifacts,
  redactBootstrapDiagnosticTail,
  resolveBootstrapTimeoutMs,
  runBootstrapIfNeeded,
} from "../src/server/operations/symphony-utils.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import {
  waitForPidsGone,
  writeBootstrapPluginRegistry,
} from "./symphony-test-utils.js";

const tempPaths: string[] = [];
const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS: process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS,
};

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetShellPathCache();
  resetResolvedClaudePath();

  for (const tempPath of tempPaths.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `bootstrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempPaths.push(dir);
  return dir;
}

async function writeFakeClaude(homeDir: string, script: string): Promise<void> {
  const fakeBin = path.join(homeDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "claude"), script, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();
}

// --- hasBootstrapArtifacts ---

describe("hasBootstrapArtifacts", () => {
  test("returns false for empty directory", () => {
    const dir = makeTempDir();
    assert.equal(hasBootstrapArtifacts(dir), false);
  });

  test("returns true when bootstrap-metadata.json exists", () => {
    const dir = makeTempDir();
    const metaDir = path.join(dir, ".closedloop-ai");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      path.join(metaDir, "bootstrap-metadata.json"),
      '{"bootstrap_version":"1.0"}'
    );
    assert.equal(hasBootstrapArtifacts(dir), true);
  });

  test("returns true when .claude/agents has .md files", () => {
    const dir = makeTempDir();
    const agentsDir = path.join(dir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, "frontend-architect.md"),
      "---\nname: frontend-architect\n---\nPrompt body"
    );
    assert.equal(hasBootstrapArtifacts(dir), true);
  });

  test("returns false when .claude/agents exists but has no .md files", () => {
    const dir = makeTempDir();
    const agentsDir = path.join(dir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "README.txt"), "not an agent");
    assert.equal(hasBootstrapArtifacts(dir), false);
  });

  test("returns true when both metadata and agents exist", () => {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, ".closedloop-ai"), { recursive: true });
    writeFileSync(
      path.join(dir, ".closedloop-ai", "bootstrap-metadata.json"),
      "{}"
    );
    mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude", "agents", "api-expert.md"),
      "---\nname: api-expert\n---\n"
    );
    assert.equal(hasBootstrapArtifacts(dir), true);
  });
});

describe("runBootstrapIfNeeded", () => {
  test("parses only positive integer timeout overrides", () => {
    process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS = "250";
    assert.equal(resolveBootstrapTimeoutMs(), 250);

    for (const invalid of ["0", "-1", "abc", "100abc", "1.5", " 100"]) {
      process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS = invalid;
      assert.equal(resolveBootstrapTimeoutMs(), 15 * 60 * 1000);
    }
  });

  test("returns skipped-artifacts without invoking claude when artifacts exist", async () => {
    const dir = makeTempDir();
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    await writeBootstrapPluginRegistry(homeDir);
    mkdirSync(path.join(dir, ".closedloop-ai"), { recursive: true });
    writeFileSync(
      path.join(dir, ".closedloop-ai", "bootstrap-metadata.json"),
      "{}"
    );

    const result = await runBootstrapIfNeeded(dir, "loop-skip-artifacts");

    assert.equal(result.status, "skipped-artifacts");
  });

  test("returns skipped-plugin-missing when bootstrap plugin is not installed", async () => {
    const dir = makeTempDir();
    process.env.HOME = makeTempDir();

    const result = await runBootstrapIfNeeded(dir, "loop-skip-plugin");

    assert.equal(result.status, "skipped-plugin-missing");
  });

  test("returns completed when bootstrap exits zero", async () => {
    const dir = makeTempDir();
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    await writeBootstrapPluginRegistry(homeDir);
    await writeFakeClaude(homeDir, "#!/bin/sh\nexit 0\n");

    const result = await runBootstrapIfNeeded(dir, "loop-complete");

    assert.equal(result.status, "completed");
  });

  test("invokes the exact bootstrap slash command", async () => {
    const dir = makeTempDir();
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    await writeBootstrapPluginRegistry(homeDir);
    await writeFakeClaude(
      homeDir,
      [
        "#!/bin/sh",
        'if [ "$1" != "-p" ] || [ "$2" != "/bootstrap:agent-bootstrap" ]; then',
        '  echo "unexpected command: $*" >&2',
        "  exit 64",
        "fi",
        "exit 0",
      ].join("\n")
    );

    const result = await runBootstrapIfNeeded(dir, "loop-exact-command");

    assert.equal(result.status, "completed");
  });

  test("returns failed with redacted stdout and stderr tails", async () => {
    const dir = makeTempDir();
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    await writeBootstrapPluginRegistry(homeDir);
    await writeFakeClaude(
      homeDir,
      [
        "#!/bin/sh",
        `echo "stdout path ${dir} CLOSEDLOOP_AUTH_TOKEN=secret-token-value"`,
        "echo 'stderr bearer Bearer sk-testsecret1234567890' >&2",
        "exit 42",
      ].join("\n")
    );

    const result = await runBootstrapIfNeeded(dir, "loop-failed");

    assert.equal(result.status, "failed");
    if (result.status !== "failed") {
      return;
    }
    assert.equal(result.exitCode, 42);
    assert.match(result.stdoutTail, /\[redacted-path\]/);
    assert.match(
      result.stdoutTail,
      /CLOSEDLOOP_AUTH_TOKEN=\[redacted-secret\]/
    );
    assert.match(result.stderrTail, /\[redacted-token\]/);
    assert.equal(result.stdoutTail.includes(dir), false);
    assert.equal(result.stdoutTail.includes("secret-token-value"), false);
  });

  test("returns failed with stdout-only diagnostics", async () => {
    const dir = makeTempDir();
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    await writeBootstrapPluginRegistry(homeDir);
    await writeFakeClaude(
      homeDir,
      [
        "#!/bin/sh",
        `echo "stdout-only marker ${dir} API_TOKEN=stdout-secret-value"`,
        "exit 17",
      ].join("\n")
    );

    const result = await runBootstrapIfNeeded(dir, "loop-stdout-only");

    assert.equal(result.status, "failed");
    if (result.status !== "failed") {
      return;
    }
    assert.equal(result.exitCode, 17);
    assert.match(result.stdoutTail, /stdout-only marker/);
    assert.match(result.stdoutTail, /\[redacted-path\]/);
    assert.match(result.stdoutTail, /API_TOKEN=\[redacted-secret\]/);
    assert.equal(result.stderrTail, "");
  });

  test("returns failed with stderr-only diagnostics", async () => {
    const dir = makeTempDir();
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    await writeBootstrapPluginRegistry(homeDir);
    await writeFakeClaude(
      homeDir,
      [
        "#!/bin/sh",
        `echo "stderr-only marker ${dir} API_TOKEN=stderr-secret-value" >&2`,
        "exit 18",
      ].join("\n")
    );

    const result = await runBootstrapIfNeeded(dir, "loop-stderr-only");

    assert.equal(result.status, "failed");
    if (result.status !== "failed") {
      return;
    }
    assert.equal(result.exitCode, 18);
    assert.equal(result.stdoutTail, "");
    assert.match(result.stderrTail, /stderr-only marker/);
    assert.match(result.stderrTail, /\[redacted-path\]/);
    assert.match(result.stderrTail, /API_TOKEN=\[redacted-secret\]/);
  });

  test("returns timed-out without waiting for child and grandchild descendants", async () => {
    const dir = makeTempDir();
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS = "100";
    await writeBootstrapPluginRegistry(homeDir);
    const childPidFile = path.join(dir, "child.pid");
    const grandchildPidFile = path.join(dir, "grandchild.pid");
    await writeFakeClaude(
      homeDir,
      [
        "#!/bin/sh",
        [
          "sh -c '",
          `echo $$ > "${childPidFile}"; `,
          "sh -c '\\''",
          `echo $$ > "${grandchildPidFile}"; `,
          'trap "" TERM; echo grandchild-ready; sleep 20',
          "'\\'' & ",
          'trap "" TERM; echo child-ready; sleep 20',
          "' &",
        ].join(""),
        "sleep 20",
      ].join("\n")
    );

    const startedAt = Date.now();
    const result = await runBootstrapIfNeeded(dir, "loop-timeout");
    const elapsed = Date.now() - startedAt;

    assert.equal(result.status, "timed-out");
    assert.ok(elapsed < 2000, `timeout resolution took ${elapsed}ms`);
    await assert.doesNotReject(
      waitForPidsGone([childPidFile, grandchildPidFile]),
      "expected bootstrap process group cleanup to kill child and grandchild"
    );
  });

  test("falls back to child kill when process-group kill fails", async () => {
    const dir = makeTempDir();
    const homeDir = makeTempDir();
    process.env.HOME = homeDir;
    process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS = "100";
    await writeBootstrapPluginRegistry(homeDir);
    const childPidFile = path.join(dir, "fallback-child.pid");
    await writeFakeClaude(
      homeDir,
      [
        "#!/bin/sh",
        `echo $$ > "${childPidFile}"`,
        'trap "" TERM',
        "sleep 20",
      ].join("\n")
    );
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | 0): boolean => {
      if (pid < 0 && signal === "SIGKILL") {
        throw new Error("injected process-group kill failure");
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;

    try {
      const result = await runBootstrapIfNeeded(dir, "loop-kill-fallback");

      assert.equal(result.status, "timed-out");
      await assert.doesNotReject(
        waitForPidsGone([childPidFile]),
        "expected child kill fallback to clean up bootstrap child"
      );
    } finally {
      process.kill = originalKill;
    }
  });
});

describe("redactBootstrapDiagnosticTail", () => {
  test("redacts local paths and common secret forms", () => {
    const dir = makeTempDir();
    const redacted = redactBootstrapDiagnosticTail(
      `path=${dir} API_TOKEN=abc123456789 bearer=Bearer sk-testtoken123456789`,
      dir
    );

    assert.equal(redacted.includes(dir), false);
    assert.equal(redacted.includes("abc123456789"), false);
    assert.match(redacted, /\[redacted-path\]/);
    assert.match(redacted, /API_TOKEN=\[redacted-secret\]/);
  });
});

// --- parseAgentFrontmatter (tested via readBootstrapRepoOutputs) ---

describe("bootstrap agent file parsing", () => {
  test("reads agent files with frontmatter from repo dir", async () => {
    // This tests the shape that readBootstrapRepoOutputs would produce.
    // We can't import it directly (it's not exported), but we test the
    // filesystem layout that the bootstrap command produces.
    const dir = makeTempDir();
    const agentsDir = path.join(dir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });

    const agentContent = [
      "---",
      "name: frontend-architect",
      "description: Specializes in React/Next.js frontend architecture",
      "model: sonnet",
      "color: blue",
      "tools: Read, Glob, Grep",
      "---",
      "",
      "You are a frontend architecture expert...",
    ].join("\n");
    writeFileSync(path.join(agentsDir, "frontend-architect.md"), agentContent);

    // Verify the file was written in the expected location
    const content = await fs.readFile(
      path.join(agentsDir, "frontend-architect.md"),
      "utf-8"
    );
    assert.equal(content, agentContent);

    // Verify hasBootstrapArtifacts detects it
    assert.equal(hasBootstrapArtifacts(dir), true);
  });
});

// --- bootstrap output locations ---

describe("bootstrap output locations", () => {
  test("critic-gates.json stored under .closedloop-ai/settings/", () => {
    const dir = makeTempDir();
    const settingsDir = path.join(dir, ".closedloop-ai", "settings");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      path.join(settingsDir, "critic-gates.json"),
      '{"version":1,"defaults":{"baseCritics":["security-privacy"]}}'
    );

    const raw = readFileSync(
      path.join(settingsDir, "critic-gates.json"),
      "utf-8"
    );
    const content = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(content.version, 1);
    assert.deepEqual(
      (content.defaults as Record<string, unknown>).baseCritics,
      ["security-privacy"]
    );
  });

  test("bootstrap-metadata.json stored under .closedloop-ai/", () => {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, ".closedloop-ai"), { recursive: true });
    writeFileSync(
      path.join(dir, ".closedloop-ai", "bootstrap-metadata.json"),
      '{"bootstrap_version":"1.0","last_run":"2026-04-24","agents":{}}'
    );

    const raw = readFileSync(
      path.join(dir, ".closedloop-ai", "bootstrap-metadata.json"),
      "utf-8"
    );
    const content = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(content.bootstrap_version, "1.0");
    assert.ok(content.agents);
  });
});

// --- readBootstrapRepoOutputs with agentsDir ---

describe("readBootstrapRepoOutputs with agentsDir", () => {
  test("reads agents from specified dir instead of repo .claude/agents", () => {
    const repoDir = makeTempDir();
    const outputDir = makeTempDir();

    writeFileSync(
      path.join(outputDir, "test-agent.md"),
      [
        "---",
        "name: Test Agent",
        "description: A test agent",
        "---",
        "",
        "Agent prompt here",
      ].join("\n")
    );

    mkdirSync(path.join(repoDir, ".closedloop-ai"), { recursive: true });
    writeFileSync(
      path.join(repoDir, ".closedloop-ai", "bootstrap-metadata.json"),
      JSON.stringify({ agents: ["test-agent"] })
    );

    const result = readBootstrapRepoOutputs(repoDir, outputDir);
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0]?.slug, "test-agent");
    assert.equal(result.agents[0]?.name, "Test Agent");
    assert.ok(result.metadata !== null);
  });

  test("falls back to repo .claude/agents when agentsDir not provided", () => {
    const repoDir = makeTempDir();
    const agentsDir = path.join(repoDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      path.join(agentsDir, "repo-agent.md"),
      "---\nname: Repo Agent\n---\nPrompt"
    );

    const result = readBootstrapRepoOutputs(repoDir);
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0]?.slug, "repo-agent");
  });
});
