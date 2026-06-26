import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  acquireLaunchLock,
  cleanStaleLock,
  getLockDir,
  isProcessRunning,
  readLaunchMetadata,
  readLaunchMetadataAsync,
  readProcessPidSync,
  releaseLaunchLock,
  restoreWorktreeState,
  runLoopsSetupScript,
  sanitizeTicketId,
  saveWorktreeState,
  writeLaunchMetadata,
} from "../src/server/operations/symphony-utils.js";

const tempPaths: string[] = [];

afterEach(async () => {
  for (const tempPath of tempPaths.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `symphony-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempPaths.push(dir);
  return dir;
}

// --- worktree state save/restore ---

describe("worktree state save/restore", () => {
  test("preserves .closedloop-ai state across worktree recreation", () => {
    const dir = makeTempDir();
    const workDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(path.join(workDir, "state.json"), '{"status":"RUNNING"}');

    const saved = saveWorktreeState(dir);
    restoreWorktreeState(saved, dir);

    assert.equal(
      readFileSync(
        path.join(dir, ".closedloop-ai", "work", "state.json"),
        "utf-8"
      ),
      '{"status":"RUNNING"}'
    );
  });

  test("ignores legacy .claude/work state", () => {
    const dir = makeTempDir();
    const attachmentsDir = path.join(dir, ".claude", "work", "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(path.join(attachmentsDir, "image.png"), "binary-data");

    const saved = saveWorktreeState(dir);
    restoreWorktreeState(saved, dir);

    assert.equal(
      existsSync(
        path.join(dir, ".closedloop-ai", "work", "attachments", "image.png")
      ),
      false
    );
  });

  test("preserves .claude/agents without restoring unrelated .claude state", () => {
    const dir = makeTempDir();
    const agentsDir = path.join(dir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "custom-agent.md"), "# custom agent");
    writeFileSync(
      path.join(dir, ".claude", "settings.json"),
      '{"legacy":true}'
    );

    const saved = saveWorktreeState(dir);

    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude", "settings.json"),
      '{"tracked":true}'
    );

    restoreWorktreeState(saved, dir);

    assert.equal(
      readFileSync(
        path.join(dir, ".claude", "agents", "custom-agent.md"),
        "utf-8"
      ),
      "# custom agent"
    );
    assert.equal(
      readFileSync(path.join(dir, ".claude", "settings.json"), "utf-8"),
      '{"tracked":true}'
    );
  });
});

// --- readProcessPidSync ---

describe("readProcessPidSync", () => {
  test("returns null when process.pid file is missing", () => {
    const dir = makeTempDir();
    assert.equal(readProcessPidSync(dir), null);
  });

  test("returns parsed PID from valid file", () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(path.join(claudeWorkDir, "process.pid"), "12345");

    assert.equal(readProcessPidSync(dir), 12_345);
  });

  test("returns null for non-numeric content", () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(path.join(claudeWorkDir, "process.pid"), "not-a-pid");

    assert.equal(readProcessPidSync(dir), null);
  });
});

// --- isProcessRunning ---

describe("isProcessRunning", () => {
  test("returns true for own process (self-check)", () => {
    assert.equal(isProcessRunning(process.pid), true);
  });

  test("returns false for a non-existent PID", () => {
    assert.equal(isProcessRunning(999_999_999), false);
  });
});

// --- readLaunchMetadata ---

describe("readLaunchMetadata", () => {
  test("returns null when file is missing", () => {
    const dir = makeTempDir();
    assert.equal(readLaunchMetadata(dir), null);
  });

  test("returns baseBranch and parentTicketId from valid file", () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      path.join(claudeWorkDir, "launch-metadata.json"),
      JSON.stringify({ baseBranch: "main", parentTicketId: "AI-100" })
    );

    const meta = readLaunchMetadata(dir);
    assert.deepEqual(meta, {
      artifactId: undefined,
      baseBranch: "main",
      issueId: undefined,
      loopId: undefined,
      parentTicketId: "AI-100",
      ticketTitle: undefined,
    });
  });

  test("async reader matches sync metadata parsing", async () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      path.join(claudeWorkDir, "launch-metadata.json"),
      JSON.stringify({ artifactId: "FEA-2015", loopId: "loop-1" })
    );

    assert.deepEqual(
      await readLaunchMetadataAsync(dir),
      readLaunchMetadata(dir)
    );
  });

  test("returns null for malformed JSON", () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(path.join(claudeWorkDir, "launch-metadata.json"), "not json");

    assert.equal(readLaunchMetadata(dir), null);
  });

  test("ignores non-string fields", () => {
    const dir = makeTempDir();
    const claudeWorkDir = path.join(dir, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      path.join(claudeWorkDir, "launch-metadata.json"),
      JSON.stringify({ baseBranch: 123, parentTicketId: null })
    );

    const meta = readLaunchMetadata(dir);
    assert.deepEqual(meta, {
      artifactId: undefined,
      baseBranch: undefined,
      issueId: undefined,
      loopId: undefined,
      parentTicketId: undefined,
      ticketTitle: undefined,
    });
  });
});

// --- writeLaunchMetadata ---

describe("writeLaunchMetadata", () => {
  test("writes launch-metadata.json and creates .closedloop-ai/work dir", () => {
    const dir = makeTempDir();
    writeLaunchMetadata(dir, { baseBranch: "develop" });

    const metaPath = path.join(
      dir,
      ".closedloop-ai",
      "work",
      "launch-metadata.json"
    );
    assert.ok(existsSync(metaPath));
    const content = JSON.parse(readFileSync(metaPath, "utf-8"));
    assert.equal(content.baseBranch, "develop");
  });

  test("merges with existing metadata (undefined values fall back)", () => {
    const dir = makeTempDir();
    writeLaunchMetadata(dir, {
      baseBranch: "main",
      parentTicketId: "AI-50",
    });
    writeLaunchMetadata(dir, {
      baseBranch: undefined,
      parentTicketId: undefined,
    });

    const meta = readLaunchMetadata(dir);
    assert.deepEqual(meta, {
      artifactId: undefined,
      baseBranch: "main",
      issueId: undefined,
      loopId: undefined,
      parentTicketId: "AI-50",
      ticketTitle: undefined,
    });
  });

  test("overrides existing values when new values are defined", () => {
    const dir = makeTempDir();
    writeLaunchMetadata(dir, {
      baseBranch: "main",
      parentTicketId: "AI-50",
    });
    writeLaunchMetadata(dir, { baseBranch: "develop" });

    const meta = readLaunchMetadata(dir);
    assert.deepEqual(meta, {
      artifactId: undefined,
      baseBranch: "develop",
      issueId: undefined,
      loopId: undefined,
      parentTicketId: "AI-50",
      ticketTitle: undefined,
    });
  });
});

// --- acquireLaunchLock / releaseLaunchLock ---

describe("acquireLaunchLock", () => {
  test("returns fd on first call", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    const result = acquireLaunchLock(lockDir);
    assert.ok(result !== null);
    assert.equal(typeof result.fd, "number");

    releaseLaunchLock(lockDir, result.fd);
  });

  test("returns null on contention (EEXIST)", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    const first = acquireLaunchLock(lockDir);
    assert.ok(first !== null);

    const second = acquireLaunchLock(lockDir);
    assert.equal(second, null);

    releaseLaunchLock(lockDir, first.fd);
  });

  test("lock file records pid and timestamp as JSON", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    const result = acquireLaunchLock(lockDir);
    assert.ok(result !== null);

    const lockContent = JSON.parse(
      readFileSync(path.join(lockDir, "launch.lock"), "utf-8")
    );
    assert.equal(lockContent.pid, process.pid);
    assert.equal(typeof lockContent.timestamp, "number");

    releaseLaunchLock(lockDir, result.fd);
  });

  test("creates lock dir automatically if it doesn't exist", () => {
    const lockDir = path.join(makeTempDir(), "deep", "nested", "locks");
    const result = acquireLaunchLock(lockDir);
    assert.ok(result !== null);
    assert.ok(existsSync(lockDir));

    releaseLaunchLock(lockDir, result.fd);
  });
});

describe("releaseLaunchLock", () => {
  test("removes the lock file", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    const result = acquireLaunchLock(lockDir);
    assert.ok(result !== null);

    releaseLaunchLock(lockDir, result.fd);
    assert.ok(!existsSync(path.join(lockDir, "launch.lock")));
  });
});

// --- cleanStaleLock ---

describe("cleanStaleLock", () => {
  test("removes lock when owner PID is dead", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, "launch.lock"),
      JSON.stringify({ pid: 999_999_999, timestamp: Date.now() })
    );

    cleanStaleLock(lockDir);
    assert.ok(!existsSync(path.join(lockDir, "launch.lock")));
  });

  test("leaves lock alone when owner PID is alive", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, "launch.lock"),
      JSON.stringify({ pid: process.pid, timestamp: Date.now() })
    );

    cleanStaleLock(lockDir);
    assert.ok(existsSync(path.join(lockDir, "launch.lock")));
  });

  test("leaves recent corrupt lock alone (missing pid, <5s old)", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, "launch.lock"),
      JSON.stringify({ timestamp: Date.now() })
    );

    cleanStaleLock(lockDir);
    assert.ok(existsSync(path.join(lockDir, "launch.lock")));
  });

  test("removes old corrupt lock (missing pid, >5s old)", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "launch.lock");
    writeFileSync(lockPath, JSON.stringify({ timestamp: Date.now() }));

    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(lockPath, oldTime, oldTime);

    cleanStaleLock(lockDir);
    assert.ok(!existsSync(lockPath));
  });

  test("leaves recent malformed JSON lock alone", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "launch.lock"), "not json");

    cleanStaleLock(lockDir);
    assert.ok(existsSync(path.join(lockDir, "launch.lock")));
  });

  test("removes old malformed JSON lock (>5s old)", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "launch.lock");
    writeFileSync(lockPath, "not json");

    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(lockPath, oldTime, oldTime);

    cleanStaleLock(lockDir);
    assert.ok(!existsSync(lockPath));
  });

  test("no-ops when lock file does not exist", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    mkdirSync(lockDir, { recursive: true });

    // Should not throw
    cleanStaleLock(lockDir);
  });

  test("no absolute timeout — alive PID is authoritative", () => {
    const lockDir = path.join(makeTempDir(), "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "launch.lock");
    // Lock with very old timestamp but alive PID
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: 0 }));

    // Backdate the file mtime as well
    const veryOld = new Date(Date.now() - 60_000);
    utimesSync(lockPath, veryOld, veryOld);

    cleanStaleLock(lockDir);
    // Lock should still be present because the PID is alive
    assert.ok(existsSync(lockPath));
  });
});

// --- getLockDir ---

describe("getLockDir", () => {
  test("returns correct path structure", () => {
    const result = getLockDir("/parent", "my-repo", "AI-100");
    assert.equal(
      result,
      path.join("/parent", ".closedloop-ai", "locks", "my-repo-AI-100")
    );
  });
});

// --- sanitizeTicketId ---

describe("sanitizeTicketId", () => {
  test("passes through alphanumeric and dashes", () => {
    assert.equal(sanitizeTicketId("AI-100"), "AI-100");
  });

  test("replaces special characters with underscores", () => {
    assert.equal(sanitizeTicketId("AI/100 (foo)"), "AI_100__foo_");
  });
});

// --- runLoopsSetupScript ---

describe("runLoopsSetupScript", () => {
  test("runs script that exists and creates a marker file", async () => {
    const dir = makeTempDir();
    const scriptDir = path.join(dir, ".closedloop-ai");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, "loops-setup.sh"),
      '#!/bin/bash\necho "ok" > "$PWD/.setup-marker"'
    );

    await runLoopsSetupScript(dir, "test-loop-id");

    assert.ok(existsSync(path.join(dir, ".setup-marker")));
    assert.equal(
      readFileSync(path.join(dir, ".setup-marker"), "utf-8").trim(),
      "ok"
    );
  });

  test("no-ops when script does not exist", async () => {
    const dir = makeTempDir();
    // Should not throw
    await runLoopsSetupScript(dir, "test-loop-id");
  });

  test("does not throw when script exits non-zero", async () => {
    const dir = makeTempDir();
    const scriptDir = path.join(dir, ".closedloop-ai");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, "loops-setup.sh"),
      "#!/bin/bash\nexit 1"
    );

    // Should not throw — failure is non-fatal
    await runLoopsSetupScript(dir, "test-loop-id");
  });
});
