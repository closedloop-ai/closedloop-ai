/**
 * Single-root contract tests: verify that all handlers read exclusively
 * from .closedloop-ai/work.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { sanitizeTicketId } from "../src/server/operations/symphony-utils.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

const serversToClose: DesktopGatewayServer[] = [];
const tempPathsToClean: string[] = [];

afterEach(async () => {
  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }
  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

// --- Helpers ---

async function makeTmpDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `single-root-${label}-`));
  tempPathsToClean.push(dir);
  return dir;
}

async function startServer(
  tmpDir: string,
  symphonyDir?: string
): Promise<{ server: DesktopGatewayServer; baseUrl: string }> {
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "single-root-test",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir ?? path.join(tmpDir, ".closedloop-ai"),
  });
  serversToClose.push(server);
  await server.start();
  return { server, baseUrl: `http://127.0.0.1:${server.getActivePort()}` };
}

function setupWorktree(
  tmpDir: string,
  repoName: string,
  ticketId: string
): { repoPath: string; worktreeDir: string } {
  const repoPath = path.join(tmpDir, repoName);
  const sanitized = sanitizeTicketId(ticketId);
  const worktreeDir = path.join(tmpDir, `${repoName}-${sanitized}`);
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  return { repoPath, worktreeDir };
}

function writeToCanonical(
  worktreeDir: string,
  relPath: string,
  content: string
): void {
  const fullPath = path.join(worktreeDir, ".closedloop-ai", "work", relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

// --- symphony-status ---

describe("single-root: symphony-status", () => {
  test("reads state.json from .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("status");
    const { repoPath, worktreeDir } = setupWorktree(tmpDir, "repo", "SR-1");

    writeToCanonical(
      worktreeDir,
      "state.json",
      JSON.stringify({
        status: "COMPLETED",
        phase: "Done",
        timestamp: new Date().toISOString(),
      })
    );

    const { baseUrl } = await startServer(tmpDir);
    const response = await fetch(
      `${baseUrl}/api/gateway/symphony/status/SR-1?repo=${encodeURIComponent(repoPath)}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; phase: string };
    assert.equal(body.status, "COMPLETED");
    assert.equal(body.phase, "Done");
  });
});

// --- symphony-kill ---

describe("single-root: symphony-kill", () => {
  test("marks state as STOPPED in .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("kill-state");
    const { repoPath, worktreeDir } = setupWorktree(tmpDir, "repo", "SR-4");

    const { baseUrl } = await startServer(tmpDir);
    await fetch(`${baseUrl}/api/gateway/symphony/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId: "SR-4", repoPath }),
    });

    const stateContent = await fs.readFile(
      path.join(worktreeDir, ".closedloop-ai", "work", "state.json"),
      "utf-8"
    );
    const state = JSON.parse(stateContent) as { status: string };
    assert.equal(state.status, "STOPPED");
  });
});

// --- deploy status ---

describe("single-root: deploy", () => {
  test("reads deploy artifacts from .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("deploy");
    const { repoPath, worktreeDir } = setupWorktree(tmpDir, "repo", "SR-5");

    writeToCanonical(worktreeDir, "deploy.log", "canonical deploy log");

    const { baseUrl } = await startServer(tmpDir);
    const response = await fetch(
      `${baseUrl}/api/gateway/deploy/status/SR-5?repo=${encodeURIComponent(repoPath)}&worktree=${encodeURIComponent(worktreeDir)}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { logs?: string };
    if (body.logs) {
      assert.ok(body.logs.includes("canonical deploy log"));
    }
  });
});

// --- symphony-attachments ---

describe("single-root: symphony-attachments", () => {
  test("serves attachments from .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("attachments");
    const { repoPath, worktreeDir } = setupWorktree(tmpDir, "repo", "SR-9");

    writeToCanonical(
      worktreeDir,
      "attachments/screenshot.png",
      "canonical-png"
    );

    const { baseUrl } = await startServer(tmpDir);
    const response = await fetch(
      `${baseUrl}/api/gateway/symphony/attachments/SR-9/screenshot.png?repo=${encodeURIComponent(repoPath)}`
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body, "canonical-png");
  });
});

// --- symphony-chat-history ---

describe("single-root: symphony-chat-history", () => {
  test("reads chat history from .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("chat-hist");
    const { repoPath, worktreeDir } = setupWorktree(tmpDir, "repo", "SR-11");

    writeToCanonical(
      worktreeDir,
      "chat-history.json",
      JSON.stringify({
        messages: [
          {
            id: "1",
            role: "user",
            content: "canonical",
            timestamp: new Date().toISOString(),
          },
        ],
        ticketId: "SR-11",
        repoPath,
      })
    );

    const { baseUrl } = await startServer(tmpDir);
    const response = await fetch(
      `${baseUrl}/api/gateway/symphony/chat-history/SR-11?repo=${encodeURIComponent(repoPath)}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      messages: Array<{ content: string }>;
    };
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, "canonical");
  });
});

// --- symphony-logs ---

describe("single-root: symphony-logs", () => {
  test("reads logs from .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("logs");
    const { repoPath, worktreeDir } = setupWorktree(tmpDir, "repo", "SR-12");

    writeToCanonical(
      worktreeDir,
      "claude-output.jsonl",
      '{"type":"test","text":"canonical"}\n'
    );

    const { baseUrl } = await startServer(tmpDir);
    const response = await fetch(
      `${baseUrl}/api/gateway/symphony/logs/SR-12?repo=${encodeURIComponent(repoPath)}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      exists: boolean;
      format: string;
      lines: string[];
    };
    assert.equal(body.exists, true);
    assert.equal(body.format, "jsonl");
    assert.ok(body.lines[0].includes("canonical"));
  });
});

// --- symphony-plan ---

describe("single-root: symphony-plan", () => {
  test("reads plan from .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("plan");
    const { repoPath, worktreeDir } = setupWorktree(tmpDir, "repo", "SR-13");

    writeToCanonical(
      worktreeDir,
      "plan.json",
      JSON.stringify({
        title: "Canonical Plan",
        tasks: [{ id: "1", title: "Task 1", description: "desc" }],
        content: "# Canonical Plan\\nContent here",
      })
    );

    const { baseUrl } = await startServer(tmpDir);
    const response = await fetch(
      `${baseUrl}/api/gateway/symphony/plan/SR-13?repo=${encodeURIComponent(repoPath)}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { raw: { title: string } };
    assert.equal(body.raw.title, "Canonical Plan");
  });
});

// --- metadata-routes (aggregate status) ---

describe("single-root: metadata-routes", () => {
  test("reads state.json from .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("metadata");
    const workDir = path.join(tmpDir, "my-worktree");
    mkdirSync(workDir, { recursive: true });

    writeToCanonical(
      workDir,
      "state.json",
      JSON.stringify({
        status: "COMPLETED",
        phase: "Done",
      })
    );

    const { baseUrl } = await startServer(tmpDir);
    const response = await fetch(
      `${baseUrl}/api/gateway/symphony/status?workDir=${encodeURIComponent(workDir)}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      isRunning: boolean;
      status: string;
    };
    assert.equal(body.isRunning, false);
    assert.equal(body.status, "COMPLETED");
  });
});

// --- symphony-judges ---

describe("single-root: symphony-judges", () => {
  test("reads judges.json from .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("judges");
    const { repoPath, worktreeDir } = setupWorktree(tmpDir, "repo", "SR-15");

    writeToCanonical(
      worktreeDir,
      "judges.json",
      JSON.stringify({
        verdict: "approved",
        source: "canonical",
      })
    );

    const { baseUrl } = await startServer(tmpDir);
    const response = await fetch(
      `${baseUrl}/api/gateway/symphony/judges/SR-15?repo=${encodeURIComponent(repoPath)}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      exists: boolean;
      data: { source: string };
    };
    assert.equal(body.exists, true);
    assert.equal(body.data.source, "canonical");
  });
});

// --- codex provider resolution ---

describe("single-root: codex", () => {
  test("codex status reads from .closedloop-ai/work", async () => {
    const tmpDir = await makeTmpDir("codex-canon");
    const { repoPath, worktreeDir } = setupWorktree(tmpDir, "repo", "SR-18");

    writeToCanonical(
      worktreeDir,
      "codex-review-codex.json",
      JSON.stringify({
        status: "IN_PROGRESS",
        provider: "codex",
      })
    );

    const { baseUrl } = await startServer(tmpDir);
    const response = await fetch(
      `${baseUrl}/api/gateway/codex/status/SR-18?repo=${encodeURIComponent(repoPath)}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      hasReview: boolean;
      provider: string;
    };
    assert.equal(body.hasReview, true);
    assert.equal(body.provider, "codex");
  });
});
