/**
 * Integration tests for the DECOMPOSE loop command.
 *
 * Uses a fake claude binary and a mock API server to verify context-pack
 * layout, output reading, and artifact upload.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { resetResolvedClaudePath } from "../src/server/operations/symphony-loop.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import { resetShellPathCache } from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  startMockApiServer,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

const DECOMPOSE_TEST_PORTS = [39_532, 39_533, 39_534, 39_535] as const;

// ---------------------------------------------------------------------------
// Shared state and cleanup
// ---------------------------------------------------------------------------

const serversToClose: DesktopGatewayServer[] = [];
const mockServersToClose: http.Server[] = [];
const tempPathsToClean: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  resetShellPathCache();
  resetResolvedClaudePath();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }

  for (const ms of mockServersToClose.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      ms.close((err) => (err ? reject(err) : resolve()));
    });
  }

  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(
  tmpDir: string,
  fakeBin: string,
  mockPort: number,
  port: number
): DesktopGatewayServer {
  return new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: port,
    fallbackPorts: DECOMPOSE_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.test.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "decompose-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mockPort}`,
    getBinaryPaths: () => ({ claude: path.join(fakeBin, "claude") }),
  });
}

// ---------------------------------------------------------------------------
// Test 1: Context pack layout — artifacts written to .closedloop-ai/context/
// ---------------------------------------------------------------------------

test("DECOMPOSE: writes context pack with artifacts in .closedloop-ai/context/artifacts/", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "decompose-layout-"));
  tempPathsToClean.push(tmpDir);

  const captureFile = path.join(tmpDir, "capture.txt");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // Spy script: capture cwd, context files, and stdin prompt
  const spyScript = [
    "#!/bin/sh",
    `echo "CWD=$(pwd)" > ${JSON.stringify(captureFile)}`,
    `echo "PROMPT_MD=$(cat .closedloop-ai/context/prompt.md 2>/dev/null || echo MISSING)" >> ${JSON.stringify(captureFile)}`,
    `echo "ARTIFACTS=$(find .closedloop-ai/context/artifacts -maxdepth 1 -type f 2>/dev/null | sort | tr '\\n' ',')" >> ${JSON.stringify(captureFile)}`,
    `echo "REPO_INFO=$(test -f .closedloop-ai/context/repo-info.json && echo yes || echo no)" >> ${JSON.stringify(captureFile)}`,
    'echo \'{"type":"result"}\'',
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), spyScript, { mode: 0o755 });

  process.env.HOME = tmpDir;

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = makeServer(
    tmpDir,
    fakeBin,
    mock.port,
    DECOMPOSE_TEST_PORTS[0]
  );
  serversToClose.push(server);
  await server.start();

  const loopId = "dcc00001-0000-0000-0000-aaaaaaaaaaaa";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Decompose,
        closedLoopAuthToken: "tok",
        artifacts: [
          {
            id: "prd-1",
            type: "PRD",
            title: "My PRD",
            content: "The full PRD content for decomposition",
          },
          {
            id: "tmpl-1",
            type: "TEMPLATE",
            title: "Feature Template",
            content: "Template content",
          },
        ],
        prompt: "Decompose this PRD into features",
      }),
    }
  );

  assert.equal(response.status, 200);
  await waitForTerminalEvent(mock.requests, loopId);

  const captured = await fs.readFile(captureFile, "utf-8");
  const lines = captured.split("\n");
  const getValue = (prefix: string) => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length) : undefined;
  };

  // prompt.md should contain the decompose prompt
  const promptMd = getValue("PROMPT_MD=");
  assert.equal(promptMd, "Decompose this PRD into features");

  // Artifacts should be in context/artifacts/
  const artifactsRaw = getValue("ARTIFACTS=");
  assert.ok(artifactsRaw, "Artifacts listing should be captured");
  assert.ok(
    artifactsRaw!.includes("prd-prd-1.md"),
    `Should contain PRD artifact: ${artifactsRaw}`
  );
  assert.ok(
    artifactsRaw!.includes("template-tmpl-1.md"),
    `Should contain template artifact: ${artifactsRaw}`
  );
});

// ---------------------------------------------------------------------------
// Test 2: features.json uploaded when written by Claude
// ---------------------------------------------------------------------------

test("DECOMPOSE: uploads { features: ... } when features.json is written", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "decompose-upload-"));
  tempPathsToClean.push(tmpDir);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // Fake claude that writes features.json to cwd
  const fakeScript = [
    "#!/bin/sh",
    'printf \'[{"title":"Feature 1"},{"title":"Feature 2"}]\' > features.json',
    'echo \'{"type":"result"}\'',
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), fakeScript, { mode: 0o755 });

  process.env.HOME = tmpDir;

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = makeServer(
    tmpDir,
    fakeBin,
    mock.port,
    DECOMPOSE_TEST_PORTS[0]
  );
  serversToClose.push(server);
  await server.start();

  const loopId = "dcc00002-0000-0000-0000-bbbbbbbbbbbb";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Decompose,
        closedLoopAuthToken: "tok",
        artifacts: [
          { id: "prd-1", type: "PRD", title: "PRD", content: "PRD content" },
        ],
        prompt: "Decompose into features",
      }),
    }
  );

  assert.equal(response.status, 200);

  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts: { features?: unknown };
  };

  assert.ok(
    uploadBody.artifacts.features,
    "Upload should contain features artifact"
  );
  const features = uploadBody.artifacts.features as Array<{ title: string }>;
  assert.equal(features.length, 2);
  assert.equal(features[0].title, "Feature 1");

  await waitForTerminalEvent(mock.requests, loopId);
});

// ---------------------------------------------------------------------------
// Test 3: Empty output — features.json not written
// ---------------------------------------------------------------------------

test("DECOMPOSE: uploads empty artifacts when features.json is not written", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "decompose-noout-"));
  tempPathsToClean.push(tmpDir);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    '#!/bin/sh\necho \'{"type":"result"}\'\nexit 0\n',
    { mode: 0o755 }
  );

  process.env.HOME = tmpDir;

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = makeServer(
    tmpDir,
    fakeBin,
    mock.port,
    DECOMPOSE_TEST_PORTS[0]
  );
  serversToClose.push(server);
  await server.start();

  const loopId = "dcc00003-0000-0000-0000-cccccccccccc";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Decompose,
        closedLoopAuthToken: "tok",
        artifacts: [
          { id: "prd-1", type: "PRD", title: "PRD", content: "PRD content" },
        ],
        prompt: "Decompose into features",
      }),
    }
  );

  assert.equal(response.status, 200);

  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts: Record<string, unknown>;
  };

  assert.equal(
    uploadBody.artifacts.features,
    undefined,
    "features should be undefined when not written"
  );

  await waitForTerminalEvent(mock.requests, loopId);
});
