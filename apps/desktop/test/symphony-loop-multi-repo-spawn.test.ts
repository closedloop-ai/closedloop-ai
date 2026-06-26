/**
 * Spawn tests for multi-repo PLAN requests: verify that native Claude command
 * launches receive the correct --add-dir arguments when additionalRepos are
 * provided.
 *
 * T-7.2: Add spawn tests in apps/desktop/test/symphony-loop-multi-repo-spawn.test.ts
 *
 * Test cases:
 * 1. PLAN with 2 additionalRepos — assert args contain --add-dir <worktreeDir1>
 *    and --add-dir <worktreeDir2>
 *
 * Strategy: the fake claude binary writes its arguments and env to temp files.
 * After waitForTerminalEvent, we assert on the presence or absence of --add-dir
 * args and multi-repo env vars.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { setShellPathForTest } from "../src/server/shell-path.js";
import {
  makeFakeWorktreeProvider,
  makeMultiRepoGateway,
  makeMultiRepoTestHarness,
  PRD_PEER_COMMANDS,
  startMockApiServer,
  waitForTerminalEvent,
  writeBootstrapPluginRegistry,
} from "./symphony-test-utils.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const fakeWorktreeProvider = makeFakeWorktreeProvider(
  "symphony/multi-repo-spawn-test"
);

const { serversToClose, mockServersToClose, tempPathsToClean, cleanup } =
  makeMultiRepoTestHarness();
afterEach(cleanup);

/**
 * Fake claude body shared by the FEA-1088 PLAN spawn tests. Captures argv,
 * prompt stdin, and the three multi-repo env vars — falling back to the
 * literal `__UNSET__` sentinel when a var is unset so the negative test can
 * distinguish "absent" from "empty string".
 * Kept module-level so both the 2-peer and 0-peer tests stay in sync if the
 * capture contract changes.
 */
function buildMultiRepoCaptureScript(params: {
  argvFile: string;
  envFile: string;
  promptFile: string;
}): string {
  return [
    "#!/bin/sh",
    `cat > ${JSON.stringify(params.promptFile)}`,
    `printf '%s' "$*" > ${JSON.stringify(params.argvFile)}`,
    "{",
    '  printf "CLOSEDLOOP_ADD_DIRS=%s\\n" "${CLOSEDLOOP_ADD_DIRS-__UNSET__}"',
    '  printf "CLOSEDLOOP_ADD_DIR_NAMES=%s\\n" "${CLOSEDLOOP_ADD_DIR_NAMES-__UNSET__}"',
    '  printf "CLOSEDLOOP_REPO_MAP=%s\\n" "${CLOSEDLOOP_REPO_MAP-__UNSET__}"',
    `} > ${JSON.stringify(params.envFile)}`,
    `echo '{"type":"result"}'`,
    "exit 0",
  ].join("\n");
}

/** Create a gateway server with a mock API backend and the worktreeProvider. */
function createTestGateway(tmpDir: string, mockPort: number) {
  return makeMultiRepoGateway({
    tmpDir,
    mockPort,
    machineName: "multi-repo-spawn-test",
    worktreeProvider: fakeWorktreeProvider,
    serversToClose,
  });
}

function bootstrapOutputChunks(
  requests: Array<{ url: string; body: string }>,
  loopId: string
): string[] {
  return requests
    .filter((request) => request.url.includes(`/loops/${loopId}/events`))
    .flatMap((request) => {
      try {
        const event = JSON.parse(request.body) as {
          type?: unknown;
          data?: { chunk?: unknown };
        };
        return event.type === "output" &&
          typeof event.data?.chunk === "string" &&
          event.data.chunk.startsWith("[bootstrap-")
          ? [event.data.chunk]
          : [];
      } catch {
        return [];
      }
    });
}

// ---------------------------------------------------------------------------
// Test 1: PLAN with 2 additionalRepos — assert args contain
//         --add-dir <worktreeDir1> and --add-dir <worktreeDir2>
// ---------------------------------------------------------------------------

test("PLAN with 2 additionalRepos passes --add-dir for each worktree to native Claude", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "multi-repo-spawn-plan2-")
  );
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });

  const additionalRepo1 = path.join(tmpDir, "additional-repo-1");
  await fs.mkdir(additionalRepo1, { recursive: true });

  const additionalRepo2 = path.join(tmpDir, "additional-repo-2");
  await fs.mkdir(additionalRepo2, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const argvFile = path.join(tmpDir, "capture-plan-argv.txt");
  const envFile = path.join(tmpDir, "capture-plan-env.txt");
  const promptFile = path.join(tmpDir, "capture-plan-prompt.txt");
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    buildMultiRepoCaptureScript({ argvFile, envFile, promptFile }),
    { mode: 0o755 }
  );

  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-0000-0000-000000007001";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `spawn-test/${path.basename(primaryRepo)}`,
          branch: "main",
        },
        additionalRepos: [
          { localRepoPath: additionalRepo1, branch: "main" },
          { localRepoPath: additionalRepo2, branch: "main" },
        ],
      }),
    }
  );

  assert.equal(response.status, 200);

  // Wait for the terminal event; assert it is "completed" so an unexpected
  // "error" event surfaces immediately with its payload rather than an
  // opaque 20s timeout.
  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(
    terminalEvent.type,
    "completed",
    `Expected terminal event type 'completed', got '${terminalEvent.type}': ${JSON.stringify(terminalEvent)}`
  );
  assert.equal(
    bootstrapOutputChunks(mock.requests, loopId).length,
    0,
    "expected no plugin bootstrap output for native command-pack PLAN"
  );

  const spawnArgs = (await fs.readFile(argvFile, "utf-8")).trim();

  assert.ok(
    spawnArgs.includes("--add-dir"),
    `Expected --add-dir in spawn args, got: ${spawnArgs}`
  );

  // Count occurrences of --add-dir to confirm both repos got an entry
  const addDirCount = (spawnArgs.match(/--add-dir/g) ?? []).length;
  assert.equal(
    addDirCount,
    2,
    `Expected exactly 2 --add-dir flags in spawn args, got ${addDirCount}. Args: ${spawnArgs}`
  );

  // Each additional repo worktree should have a dir under worktreeParent
  const addDirMatches = [...spawnArgs.matchAll(/--add-dir\s+(\S+)/g)].map(
    (m) => m[1]
  );
  assert.equal(
    addDirMatches.length,
    2,
    "Should parse 2 --add-dir paths from spawn args"
  );

  for (const addDir of addDirMatches) {
    assert.ok(
      addDir.startsWith(worktreeParent),
      `Expected --add-dir path "${addDir}" to start with worktreeParent "${worktreeParent}"`
    );
  }

  // FEA-1088: the same multi-repo data must also reach the spawn env so that
  // every bash subshell Claude's agents launch sees CLOSEDLOOP_ADD_DIRS and
  // the plan-draft-writer skill's multi-repo gate evaluates true. Without
  // this the agent silently produces a single-repo plan.
  const spawnEnv = await fs.readFile(envFile, "utf-8");
  const envMap = new Map<string, string>();
  for (const line of spawnEnv.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      envMap.set(line.slice(0, eq), line.slice(eq + 1));
    }
  }

  const addDirs = envMap.get("CLOSEDLOOP_ADD_DIRS") ?? "";
  assert.notEqual(
    addDirs,
    "__UNSET__",
    `CLOSEDLOOP_ADD_DIRS must be set in spawn env, got UNSET. Captured: ${spawnEnv}`
  );
  const addDirParts = addDirs.split("|").filter((s) => s.length > 0);
  assert.equal(
    addDirParts.length,
    2,
    `CLOSEDLOOP_ADD_DIRS must contain 2 pipe-joined paths, got ${addDirParts.length}: ${addDirs}`
  );
  for (const dir of addDirParts) {
    assert.ok(
      dir.startsWith(worktreeParent),
      `CLOSEDLOOP_ADD_DIRS entry "${dir}" must live under worktreeParent "${worktreeParent}"`
    );
  }

  const repoMap = envMap.get("CLOSEDLOOP_REPO_MAP") ?? "";
  const repoMapParts = repoMap.split("|").filter((s) => s.length > 0);
  assert.equal(
    repoMapParts.length,
    2,
    `CLOSEDLOOP_REPO_MAP must contain 2 name=path entries, got ${repoMapParts.length}: ${repoMap}`
  );
  for (const part of repoMapParts) {
    assert.ok(
      /^[^=]+=.+/.test(part),
      `CLOSEDLOOP_REPO_MAP entry "${part}" must match name=path`
    );
    const [, p] = part.split("=", 2);
    assert.ok(
      p.startsWith(worktreeParent),
      `CLOSEDLOOP_REPO_MAP path "${p}" must live under worktreeParent`
    );
  }

  const addDirNames = envMap.get("CLOSEDLOOP_ADD_DIR_NAMES") ?? "";
  const nameParts = addDirNames.split("|").filter((s) => s.length > 0);
  assert.equal(
    nameParts.length,
    2,
    `CLOSEDLOOP_ADD_DIR_NAMES must contain 2 names, got ${nameParts.length}: ${addDirNames}`
  );
  // Names must be unique within the dispatch — the skill's @{name}:path
  // prefix breaks if two peers collide.
  assert.equal(
    new Set(nameParts).size,
    nameParts.length,
    `CLOSEDLOOP_ADD_DIR_NAMES entries must be unique: ${addDirNames}`
  );
});

// ---------------------------------------------------------------------------
// FEA-1088: single-repo PLAN must not leak multi-repo env vars into spawn env
// ---------------------------------------------------------------------------

test("PLAN with no additionalRepos: multi-repo env vars are absent from spawn env", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "multi-repo-spawn-plan0-")
  );
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const argvFile = path.join(tmpDir, "capture-plan-empty-argv.txt");
  const envFile = path.join(tmpDir, "capture-plan-empty-env.txt");
  const promptFile = path.join(tmpDir, "capture-plan-empty-prompt.txt");
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    buildMultiRepoCaptureScript({ argvFile, envFile, promptFile }),
    { mode: 0o755 }
  );

  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-0000-0000-000000007002";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `spawn-test/${path.basename(primaryRepo)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(response.status, 200);
  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(
    terminalEvent.type,
    "completed",
    `Expected completed, got '${terminalEvent.type}': ${JSON.stringify(terminalEvent)}`
  );

  const spawnArgs = await fs.readFile(argvFile, "utf-8");
  const spawnEnv = await fs.readFile(envFile, "utf-8");

  assert.ok(
    !spawnArgs.includes("--add-dir"),
    `Single-repo PLAN must not include --add-dir; got: ${spawnArgs}`
  );

  // Single-repo path: the harness must not set any of the multi-repo env
  // vars, so the bash check sees the literal __UNSET__ sentinel.
  assert.ok(
    spawnEnv.includes("CLOSEDLOOP_ADD_DIRS=__UNSET__"),
    `Single-repo PLAN must not set CLOSEDLOOP_ADD_DIRS; got: ${spawnEnv}`
  );
  assert.ok(
    spawnEnv.includes("CLOSEDLOOP_ADD_DIR_NAMES=__UNSET__"),
    `Single-repo PLAN must not set CLOSEDLOOP_ADD_DIR_NAMES; got: ${spawnEnv}`
  );
  assert.ok(
    spawnEnv.includes("CLOSEDLOOP_REPO_MAP=__UNSET__"),
    `Single-repo PLAN must not set CLOSEDLOOP_REPO_MAP; got: ${spawnEnv}`
  );
});

// ---------------------------------------------------------------------------
// PRD spawn matrix: --add-dir, peer-repos.json, and "## Mounted paths" footer
//
// GENERATE_PRD and REQUEST_PRD_CHANGES go through the direct-claude pipeline
// (buildClaudePipeline), not run-loop.sh. We use a fake claude binary that
// captures argv + the contents of the prompt file + peer-repos.json. The
// captured data lets us assert all three peer-wiring outputs at once.
// ---------------------------------------------------------------------------

for (const command of PRD_PEER_COMMANDS) {
  test(`${command} with 2 peers: --add-dir x2, peer-repos.json, and ## Mounted paths footer`, async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `multi-repo-prd-spawn-${command.toLowerCase()}-`)
    );
    tempPathsToClean.push(tmpDir);

    const primaryRepo = path.join(tmpDir, "primary-repo");
    await fs.mkdir(primaryRepo, { recursive: true });
    const peer1 = path.join(tmpDir, "peer-1");
    await fs.mkdir(peer1, { recursive: true });
    const peer2 = path.join(tmpDir, "peer-2");
    await fs.mkdir(peer2, { recursive: true });

    const worktreeParent = path.join(tmpDir, "worktrees");
    await fs.mkdir(worktreeParent, { recursive: true });

    process.env.HOME = tmpDir;
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
    await writeBootstrapPluginRegistry(tmpDir);

    // Dedicated capture files (outside the worktree so they survive cleanup).
    // Multi-line values like the pretty-printed peer-repos.json manifest and
    // the prompt + Mounted-paths footer cannot fit a line-oriented "KEY=value"
    // format — write each to its own file so the test can read them as-is.
    const argvFile = path.join(tmpDir, `capture-argv-${command}.txt`);
    const promptFile = path.join(tmpDir, `capture-prompt-${command}.txt`);
    const manifestFile = path.join(tmpDir, `capture-manifest-${command}.json`);

    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });
    // Read the prompt from stdin (the pipeline pipes via < $promptFile),
    // capture argv + prompt + the peer manifest, then output a JSON line so
    // the pipeline grep/tee step succeeds.
    const spyScript = [
      "#!/bin/sh",
      `cat > ${JSON.stringify(promptFile)}`,
      `printf '%s' "$*" > ${JSON.stringify(argvFile)}`,
      "if [ -f .closedloop-ai/context/peer-repos.json ]; then",
      `  cp .closedloop-ai/context/peer-repos.json ${JSON.stringify(manifestFile)}`,
      "fi",
      `echo '{"type":"result"}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), spyScript, {
      mode: 0o755,
    });

    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const mock = await startMockApiServer();
    mockServersToClose.push(mock.server);
    const server = await createTestGateway(tmpDir, mock.port);

    const loopId =
      command === LoopCommand.GeneratePrd
        ? "00000000-0000-0000-0000-000000007101"
        : "00000000-0000-0000-0000-000000007102";

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loopId,
          command,
          closedLoopAuthToken: "tok",
          artifacts:
            command === LoopCommand.RequestPrdChanges
              ? [
                  {
                    id: "art-1",
                    type: "prd",
                    title: "Existing PRD",
                    content: "PRD body",
                  },
                ]
              : [],
          prompt: "Generate / amend the PRD",
          repo: {
            fullName: `prd-spawn/${path.basename(primaryRepo)}`,
            branch: "main",
          },
          additionalRepos: [
            { fullName: "org/peer-1", localRepoPath: peer1, branch: "main" },
            {
              fullName: "org/peer-2",
              localRepoPath: peer2,
              branch: "develop",
            },
          ],
        }),
      }
    );

    assert.equal(
      response.status,
      200,
      `Expected 200, got ${response.status}: ${await response.text().catch(() => "")}`
    );

    const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
    assert.equal(
      terminalEvent.type,
      "completed",
      `Expected completed, got '${terminalEvent.type}': ${JSON.stringify(terminalEvent)}`
    );
    assert.equal(
      bootstrapOutputChunks(mock.requests, loopId).filter((chunk) =>
        chunk.startsWith("[bootstrap-completed]")
      ).length,
      3,
      `${command}: expected bootstrap to run for both additional repos and the primary repo`
    );

    // AC-001: --add-dir for each peer; the worktree dirs live under worktreeParent.
    const argv = await fs.readFile(argvFile, "utf-8");
    const addDirCount = (argv.match(/--add-dir/g) ?? []).length;
    assert.equal(
      addDirCount,
      2,
      `${command}: expected exactly 2 --add-dir flags, got ${addDirCount} in: ${argv}`
    );

    // peer-repos.json: written by writeArtifactsForGeneratePrd, must enumerate
    // both peers with fullName + branch + localPath matching the worktree dirs.
    // Read the file as-is — it's pretty-printed JSON written by JSON.stringify(_, null, 2).
    const manifestRaw = await fs.readFile(manifestFile, "utf-8").catch(() => {
      throw new Error(`${command}: peer-repos.json must exist in context dir`);
    });
    const manifest = JSON.parse(manifestRaw) as {
      peers: Array<{ fullName: string; branch: string; localPath: string }>;
    };
    assert.equal(
      manifest.peers.length,
      2,
      `${command}: peer-repos.json must list 2 peers; got ${manifest.peers.length}`
    );
    const peerNames = manifest.peers.map((p) => p.fullName).sort();
    assert.deepEqual(peerNames, ["org/peer-1", "org/peer-2"]);

    // AC-001 + AC-002: the prompt text piped to the spawn includes a
    // "## Mounted paths" footer enumerating each peer with its branch + path.
    // The prompt is multi-line (footer adds \n\n## Mounted paths\n\n…), so we
    // read the captured stdin as-is rather than line-parsing it.
    const prompt = await fs.readFile(promptFile, "utf-8");
    assert.ok(
      prompt.includes("## Mounted paths"),
      `${command}: prompt must contain Mounted paths footer; got: ${prompt}`
    );
    assert.ok(
      prompt.includes("org/peer-1"),
      `${command}: footer must list peer-1 fullName`
    );
    assert.ok(
      prompt.includes("develop"),
      `${command}: footer must list peer-2 branch 'develop'`
    );
  });

  test(`${command} with zero peers: no --add-dir, no peer-repos.json, no footer`, async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        `multi-repo-prd-spawn-empty-${command.toLowerCase()}-`
      )
    );
    tempPathsToClean.push(tmpDir);

    const primaryRepo = path.join(tmpDir, "primary-repo");
    await fs.mkdir(primaryRepo, { recursive: true });
    const worktreeParent = path.join(tmpDir, "worktrees");
    await fs.mkdir(worktreeParent, { recursive: true });

    process.env.HOME = tmpDir;
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
    await writeBootstrapPluginRegistry(tmpDir);

    const argvFile = path.join(tmpDir, `capture-empty-argv-${command}.txt`);
    const promptFile = path.join(tmpDir, `capture-empty-prompt-${command}.txt`);
    const manifestFlagFile = path.join(
      tmpDir,
      `capture-empty-manifest-flag-${command}.txt`
    );
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });
    const spyScript = [
      "#!/bin/sh",
      `cat > ${JSON.stringify(promptFile)}`,
      `printf '%s' "$*" > ${JSON.stringify(argvFile)}`,
      "if [ -f .closedloop-ai/context/peer-repos.json ]; then",
      `  printf yes > ${JSON.stringify(manifestFlagFile)}`,
      "else",
      `  printf no > ${JSON.stringify(manifestFlagFile)}`,
      "fi",
      `echo '{"type":"result"}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), spyScript, {
      mode: 0o755,
    });

    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const mock = await startMockApiServer();
    mockServersToClose.push(mock.server);
    const server = await createTestGateway(tmpDir, mock.port);

    const loopId =
      command === LoopCommand.GeneratePrd
        ? "00000000-0000-0000-0000-000000007201"
        : "00000000-0000-0000-0000-000000007202";

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loopId,
          command,
          closedLoopAuthToken: "tok",
          artifacts:
            command === LoopCommand.RequestPrdChanges
              ? [
                  {
                    id: "art-1",
                    type: "prd",
                    title: "Existing PRD",
                    content: "PRD body",
                  },
                ]
              : [],
          prompt: "No peers",
          repo: {
            fullName: `prd-spawn/${path.basename(primaryRepo)}`,
            branch: "main",
          },
        }),
      }
    );

    assert.equal(response.status, 200);
    await waitForTerminalEvent(mock.requests, loopId);
    assert.equal(
      bootstrapOutputChunks(mock.requests, loopId).filter((chunk) =>
        chunk.startsWith("[bootstrap-completed]")
      ).length,
      1,
      `${command}: expected bootstrap to run for the primary repo`
    );

    const argv = await fs.readFile(argvFile, "utf-8");
    assert.ok(
      !argv.includes("--add-dir"),
      `${command}: zero peers must not emit --add-dir; got: ${argv}`
    );
    const manifestFlag = await fs.readFile(manifestFlagFile, "utf-8");
    assert.equal(
      manifestFlag,
      "no",
      `${command}: peer-repos.json must be absent when no peers supplied`
    );
    const prompt = await fs.readFile(promptFile, "utf-8");
    assert.ok(
      !prompt.includes("## Mounted paths"),
      `${command}: zero peers must not emit Mounted paths footer; got: ${prompt}`
    );
  });
}
