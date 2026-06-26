import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  materializeAgents,
  materializeCriticGates,
} from "../src/server/operations/symphony-loop.js";

const tempPaths: string[] = [];

afterEach(async () => {
  for (const tempPath of tempPaths.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `ctx-mat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempPaths.push(dir);
  return dir;
}

// --- materializeAgents ---

describe("materializeAgents", () => {
  test("writes agent files to .claude/agents/{slug}.md", async () => {
    const dir = makeTempDir();
    const agents = [
      {
        slug: "api-expert",
        name: "API Expert",
        prompt: "---\nname: api-expert\n---\nYou are an API expert.\n",
      },
      {
        slug: "frontend-arch",
        name: "Frontend Architect",
        prompt:
          "---\nname: frontend-arch\n---\nYou are a frontend architect.\n",
      },
    ];

    const count = await materializeAgents(dir, agents);

    assert.equal(count, 2);
    const file1 = readFileSync(
      path.join(dir, ".claude", "agents", "api-expert.md"),
      "utf-8"
    );
    assert.equal(file1, "---\nname: api-expert\n---\nYou are an API expert.\n");
    const file2 = readFileSync(
      path.join(dir, ".claude", "agents", "frontend-arch.md"),
      "utf-8"
    );
    assert.equal(
      file2,
      "---\nname: frontend-arch\n---\nYou are a frontend architect.\n"
    );
  });

  test("appends trailing newline when missing", async () => {
    const dir = makeTempDir();
    const agents = [
      {
        slug: "test-agent",
        name: "Test",
        prompt: "---\nname: test-agent\n---\nNo trailing newline",
      },
    ];

    await materializeAgents(dir, agents);

    const content = readFileSync(
      path.join(dir, ".claude", "agents", "test-agent.md"),
      "utf-8"
    );
    assert.ok(content.endsWith("\n"));
  });

  test("does not double trailing newline", async () => {
    const dir = makeTempDir();
    const agents = [
      { slug: "test-agent", name: "Test", prompt: "prompt content\n" },
    ];

    await materializeAgents(dir, agents);

    const content = readFileSync(
      path.join(dir, ".claude", "agents", "test-agent.md"),
      "utf-8"
    );
    assert.equal(content, "prompt content\n");
  });

  test("returns 0 and writes nothing for empty array", async () => {
    const dir = makeTempDir();
    const count = await materializeAgents(dir, []);

    assert.equal(count, 0);
    assert.equal(existsSync(path.join(dir, ".claude", "agents")), false);
  });

  test("preserves non-conflicting repo agent files", async () => {
    const dir = makeTempDir();
    const agentsDir = path.join(dir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "repo-only.md"), "repo agent content\n");

    const agents = [
      { slug: "db-agent", name: "DB Agent", prompt: "db prompt\n" },
    ];

    await materializeAgents(dir, agents);

    assert.equal(
      readFileSync(path.join(agentsDir, "repo-only.md"), "utf-8"),
      "repo agent content\n"
    );
    assert.equal(
      readFileSync(path.join(agentsDir, "db-agent.md"), "utf-8"),
      "db prompt\n"
    );
  });

  test("sanitizes path-traversal slugs and blocks escapes", async () => {
    const dir = makeTempDir();
    const agents = [
      { slug: "../../etc/evil", name: "Evil", prompt: "pwned\n" },
      { slug: "../escape", name: "Escape", prompt: "escaped\n" },
      { slug: "good-agent", name: "Good", prompt: "safe\n" },
    ];

    const count = await materializeAgents(dir, agents);

    assert.equal(existsSync(path.join(dir, "..", "etc", "evil.md")), false);
    assert.equal(existsSync(path.join(dir, "..", "escape.md")), false);
    assert.equal(
      readFileSync(
        path.join(dir, ".claude", "agents", "good-agent.md"),
        "utf-8"
      ),
      "safe\n"
    );
    assert.ok(count <= 3);
  });

  test("skips agents with missing or non-string prompt", async () => {
    const dir = makeTempDir();
    const agents = [
      {
        slug: "no-prompt",
        name: "No Prompt",
        prompt: null as unknown as string,
      },
      { slug: "valid", name: "Valid", prompt: "content\n" },
    ];

    const count = await materializeAgents(dir, agents);

    assert.equal(count, 1);
    assert.equal(
      existsSync(path.join(dir, ".claude", "agents", "no-prompt.md")),
      false
    );
    assert.equal(
      readFileSync(path.join(dir, ".claude", "agents", "valid.md"), "utf-8"),
      "content\n"
    );
  });

  test("overwrites conflicting repo agent files (DB wins)", async () => {
    const dir = makeTempDir();
    const agentsDir = path.join(dir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, "shared-agent.md"),
      "old repo version\n"
    );

    const agents = [
      {
        slug: "shared-agent",
        name: "Shared Agent",
        prompt: "new DB version\n",
      },
    ];

    await materializeAgents(dir, agents);

    assert.equal(
      readFileSync(path.join(agentsDir, "shared-agent.md"), "utf-8"),
      "new DB version\n"
    );
  });
});

// --- materializeCriticGates ---

describe("materializeCriticGates", () => {
  test("writes critic-gates.json for matching repo", async () => {
    const dir = makeTempDir();
    const repoConfigs = [
      {
        repoFullName: "org/repo-a",
        criticGates: { version: 1, gates: ["security"] },
      },
      {
        repoFullName: "org/repo-b",
        criticGates: { version: 2, gates: ["perf"] },
      },
    ];

    const wrote = await materializeCriticGates(dir, "org/repo-a", repoConfigs);

    assert.equal(wrote, true);
    const content = JSON.parse(
      readFileSync(
        path.join(dir, ".closedloop-ai", "settings", "critic-gates.json"),
        "utf-8"
      )
    );
    assert.deepEqual(content, { version: 1, gates: ["security"] });
  });

  test("returns false when no config matches repoFullName", async () => {
    const dir = makeTempDir();
    const repoConfigs = [
      { repoFullName: "org/other-repo", criticGates: { version: 1 } },
    ];

    const wrote = await materializeCriticGates(dir, "org/my-repo", repoConfigs);

    assert.equal(wrote, false);
    assert.equal(
      existsSync(path.join(dir, ".closedloop-ai", "settings")),
      false
    );
  });

  test("returns false for empty repoConfigs array", async () => {
    const dir = makeTempDir();
    const wrote = await materializeCriticGates(dir, "org/repo", []);

    assert.equal(wrote, false);
  });

  test("overwrites existing critic-gates.json", async () => {
    const dir = makeTempDir();
    const settingsDir = path.join(dir, ".closedloop-ai", "settings");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(path.join(settingsDir, "critic-gates.json"), '{"old": true}');

    const repoConfigs = [
      { repoFullName: "org/repo", criticGates: { new: true } },
    ];

    await materializeCriticGates(dir, "org/repo", repoConfigs);

    const content = JSON.parse(
      readFileSync(path.join(settingsDir, "critic-gates.json"), "utf-8")
    );
    assert.deepEqual(content, { new: true });
  });

  test("writes JSON with trailing newline", async () => {
    const dir = makeTempDir();
    const repoConfigs = [{ repoFullName: "org/repo", criticGates: { v: 1 } }];

    await materializeCriticGates(dir, "org/repo", repoConfigs);

    const raw = readFileSync(
      path.join(dir, ".closedloop-ai", "settings", "critic-gates.json"),
      "utf-8"
    );
    assert.ok(raw.endsWith("\n"));
  });
});
