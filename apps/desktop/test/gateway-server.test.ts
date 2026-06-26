import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, mock, test } from "node:test";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import type { LocalJob, LocalJobStatus } from "../src/main/job-store.js";
import { JobStore } from "../src/main/job-store.js";
import { Observability } from "../src/main/observability.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry-service.js";
import { saveCodexChatSession } from "../src/server/operations/codex.js";
import {
  _setKnownBinaryLocationsForTesting,
  _setPluginEnableCommandForTesting,
  _setRunCommandForTesting,
} from "../src/server/operations/health-check.js";
import {
  SymphonyDirNotConfiguredError,
  tryAssertPathAllowed,
  tryAssertRepoAllowed,
} from "../src/server/operations/symphony-utils.js";
import {
  ClaudeCodeOtelEnvVar,
  ClaudeCodeOtelReceiverState,
} from "../src/server/otel/claude-code-env.js";
import {
  ProcessManager,
  type StreamingProcessHandle,
  type StreamingSpawnOptions,
} from "../src/server/process-manager.js";
import {
  type GatewayActivityEvent,
  GatewayRouter,
} from "../src/server/router.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

const GENERIC_JSON_LIMIT_BYTES = 256 * 1024;
const SYMPHONY_LOOP_LIMIT_BYTES = 1024 * 1024;
const RELAY_DISPATCH_LIMIT_BYTES = 1_048_576;

const serversToClose: DesktopGatewayServer[] = [];
const blockersToClose: net.Server[] = [];
const tempPathsToClean: string[] = [];
const childPidsToKill: number[] = [];
const originalSymphonyWorktreeParentDir =
  process.env.SYMPHONY_WORKTREE_PARENT_DIR;
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;

class TestResponse extends EventEmitter {
  statusCode = 200;
  finished = false;
  socket = { setNoDelay: () => {} };
  readonly headers = new Map<string, string | number | readonly string[]>();
  readonly chunks: Buffer[] = [];

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders(): void {}

  write(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error) => void)
  ): boolean {
    this.appendChunk(chunk, encodingOrCallback);
    return true;
  }

  end(
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void)
  ): this {
    if (chunk != null && typeof chunk !== "function") {
      this.appendChunk(chunk, encodingOrCallback);
    }
    this.finished = true;
    this.emit("finish");
    return this;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }

  json(): Record<string, unknown> {
    return JSON.parse(this.text()) as Record<string, unknown>;
  }

  private appendChunk(
    chunk: unknown,
    encodingOrCallback?:
      | BufferEncoding
      | ((error?: Error) => void)
      | (() => void)
  ): void {
    if (typeof chunk === "string") {
      this.chunks.push(
        Buffer.from(
          chunk,
          typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8"
        )
      );
      return;
    }
    if (Buffer.isBuffer(chunk)) {
      this.chunks.push(chunk);
      return;
    }
    if (chunk instanceof Uint8Array) {
      this.chunks.push(Buffer.from(chunk));
    }
  }
}

afterEach(async () => {
  globalThis.fetch = originalFetch;

  if (originalSymphonyWorktreeParentDir === undefined) {
    delete process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  } else {
    process.env.SYMPHONY_WORKTREE_PARENT_DIR =
      originalSymphonyWorktreeParentDir;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  resetShellPathCache();

  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }

  for (const blocker of blockersToClose.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  for (const pid of childPidsToKill.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }

  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }

  // Reset Observability singleton so telemetry state does not bleed between tests
  await Observability.shutdown();
  Observability.reset();
  _setRunCommandForTesting();
  _setPluginEnableCommandForTesting();
  mock.restoreAll();
});

function createGatewayRouter(
  overrides: Partial<ConstructorParameters<typeof GatewayRouter>[0]> = {}
): GatewayRouter {
  return new GatewayRouter({
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "router-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 0,
    getGatewayId: () => "test-gateway-id",
    ...overrides,
  });
}

test("gateway chat route wires ready Claude Code OTel status through default provider", async () => {
  const fetchResponses = [
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow(),
          resumeSessionId: null,
        },
      },
    },
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow({
            sessionId: "sess-router",
            sessionSourceId: "test-gateway-id",
          }),
        },
      },
    },
  ];
  let fetchIndex = 0;
  globalThis.fetch = (async () => {
    const response = fetchResponses[fetchIndex++];
    assert.ok(response, "unexpected extra chat backend request");
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  let capturedEnv: NodeJS.ProcessEnv | undefined;
  mock.method(
    ProcessManager.prototype,
    "spawnStreaming",
    async (options: StreamingSpawnOptions): Promise<StreamingProcessHandle> => {
      capturedEnv = options.env;
      setImmediate(() => {
        options.onLine?.(
          JSON.stringify({ type: "init", sessionId: "sess-router" })
        );
        options.onExit?.(0, null);
      });
      return { pid: 4646, process: {} as never };
    }
  );

  const router = createGatewayRouter({
    getBinaryPaths: () => ({ claude: "/usr/bin/claude" }),
    getClaudeCodeOtelReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Ready,
      host: "127.0.0.1",
      port: 4318,
    }),
  });

  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/chat",
    headers: { "content-type": "application/json" },
    chunks: [
      JSON.stringify({
        chatKey: "chat-key-1",
        userMessage: {
          id: "u1",
          role: "user",
          content: "hi",
          timestamp: "2026-06-17T00:00:00.000Z",
        },
        provider: "claude",
        apiBaseUrl: "https://api.example.test",
        apiAuthToken: "token-xyz",
      }),
    ],
  });

  assert.equal(response.statusCode, 200);
  assert.ok(capturedEnv, "expected gateway chat route to spawn Claude");
  assertClaudeCodeOtelEnv(capturedEnv);
});

test("gateway chat route keeps ready OTel status after a later router has no getter", async () => {
  const fetchResponses = [
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow(),
          resumeSessionId: null,
        },
      },
    },
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow({
            sessionId: "sess-ready-router",
            sessionSourceId: "test-gateway-id",
          }),
        },
      },
    },
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow(),
          resumeSessionId: null,
        },
      },
    },
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow({
            sessionId: "sess-no-status-router",
            sessionSourceId: "test-gateway-id",
          }),
        },
      },
    },
  ];
  let fetchIndex = 0;
  globalThis.fetch = (async () => {
    const response = fetchResponses[fetchIndex++];
    assert.ok(response, "unexpected extra chat backend request");
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const capturedEnvs: NodeJS.ProcessEnv[] = [];
  mock.method(
    ProcessManager.prototype,
    "spawnStreaming",
    async (options: StreamingSpawnOptions): Promise<StreamingProcessHandle> => {
      capturedEnvs.push(options.env ?? {});
      const sessionId = `sess-router-${capturedEnvs.length}`;
      setImmediate(() => {
        options.onLine?.(JSON.stringify({ type: "init", sessionId }));
        options.onExit?.(0, null);
      });
      return { pid: 4646 + capturedEnvs.length, process: {} as never };
    }
  );

  const readyRouter = createGatewayRouter({
    getBinaryPaths: () => ({ claude: "/usr/bin/claude" }),
    getClaudeCodeOtelReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Ready,
      host: "127.0.0.1",
      port: 4318,
    }),
  });
  const noStatusRouter = createGatewayRouter({
    getBinaryPaths: () => ({ claude: "/usr/bin/claude" }),
  });
  const readyResponse = await dispatchMockRequest({
    router: readyRouter,
    method: "POST",
    path: "/api/gateway/chat",
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify(buildGatewayChatPayload())],
  });
  const noStatusResponse = await dispatchMockRequest({
    router: noStatusRouter,
    method: "POST",
    path: "/api/gateway/chat",
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify(buildGatewayChatPayload())],
  });

  assert.equal(readyResponse.statusCode, 200);
  assert.equal(noStatusResponse.statusCode, 200);
  assert.equal(capturedEnvs.length, 2);
  const readyEnv = capturedEnvs[0];
  const noStatusEnv = capturedEnvs[1];
  assert.ok(readyEnv, "expected ready router env capture");
  assert.ok(noStatusEnv, "expected no-status router env capture");
  assertClaudeCodeOtelEnv(readyEnv);
  assertNoClaudeCodeOtelEnv(noStatusEnv);
});

test("gateway chat route keeps no-status OTel behavior after a later ready router exists", async () => {
  const fetchResponses = [
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow(),
          resumeSessionId: null,
        },
      },
    },
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow({
            sessionId: "sess-no-status-router",
            sessionSourceId: "test-gateway-id",
          }),
        },
      },
    },
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow(),
          resumeSessionId: null,
        },
      },
    },
    {
      status: 200,
      body: {
        success: true,
        data: {
          chat: buildChatSessionRow({
            sessionId: "sess-ready-router",
            sessionSourceId: "test-gateway-id",
          }),
        },
      },
    },
  ];
  let fetchIndex = 0;
  globalThis.fetch = (async () => {
    const response = fetchResponses[fetchIndex++];
    assert.ok(response, "unexpected extra chat backend request");
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const capturedEnvs: NodeJS.ProcessEnv[] = [];
  mock.method(
    ProcessManager.prototype,
    "spawnStreaming",
    async (options: StreamingSpawnOptions): Promise<StreamingProcessHandle> => {
      capturedEnvs.push(options.env ?? {});
      const sessionId = `sess-router-${capturedEnvs.length}`;
      setImmediate(() => {
        options.onLine?.(JSON.stringify({ type: "init", sessionId }));
        options.onExit?.(0, null);
      });
      return { pid: 4746 + capturedEnvs.length, process: {} as never };
    }
  );

  const noStatusRouter = createGatewayRouter({
    getBinaryPaths: () => ({ claude: "/usr/bin/claude" }),
  });
  const readyRouter = createGatewayRouter({
    getBinaryPaths: () => ({ claude: "/usr/bin/claude" }),
    getClaudeCodeOtelReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Ready,
      host: "127.0.0.1",
      port: 4318,
    }),
  });
  const noStatusResponse = await dispatchMockRequest({
    router: noStatusRouter,
    method: "POST",
    path: "/api/gateway/chat",
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify(buildGatewayChatPayload())],
  });
  const readyResponse = await dispatchMockRequest({
    router: readyRouter,
    method: "POST",
    path: "/api/gateway/chat",
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify(buildGatewayChatPayload())],
  });

  assert.equal(noStatusResponse.statusCode, 200);
  assert.equal(readyResponse.statusCode, 200);
  assert.equal(capturedEnvs.length, 2);
  const noStatusEnv = capturedEnvs[0];
  const readyEnv = capturedEnvs[1];
  assert.ok(noStatusEnv, "expected no-status router env capture");
  assert.ok(readyEnv, "expected ready router env capture");
  assertNoClaudeCodeOtelEnv(noStatusEnv);
  assertClaudeCodeOtelEnv(readyEnv);
});

async function dispatchMockRequest(input: {
  router: GatewayRouter;
  method?: string;
  path: string;
  headers?: http.IncomingHttpHeaders;
  chunks?: Array<string | Buffer>;
  remoteAddress?: string;
}): Promise<TestResponse> {
  const request = Readable.from(input.chunks ?? []) as Readable & {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  };
  request.method = input.method ?? "POST";
  request.url = input.path;
  request.headers = input.headers ?? {};
  request.socket = { remoteAddress: input.remoteAddress ?? "127.0.0.1" };

  const response = new TestResponse();
  await input.router.handle(
    request as unknown as http.IncomingMessage,
    response as unknown as http.ServerResponse
  );
  if (!response.finished) {
    await new Promise<void>((resolve) =>
      response.once("finish", () => resolve())
    );
  }
  return response;
}

function buildChatSessionRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "chat-1",
    chatKey: "chat-key-1",
    provider: "claude",
    model: "claude-sonnet-4-5",
    context: null,
    messages: [
      {
        id: "u1",
        role: "user",
        content: "hi",
        timestamp: "2026-06-17T00:00:00.000Z",
      },
    ],
    sessionId: null,
    sessionSourceId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

function buildGatewayChatPayload(): Record<string, unknown> {
  return {
    chatKey: "chat-key-1",
    userMessage: {
      id: "u1",
      role: "user",
      content: "hi",
      timestamp: "2026-06-17T00:00:00.000Z",
    },
    provider: "claude",
    apiBaseUrl: "https://api.example.test",
    apiAuthToken: "token-xyz",
  };
}

function assertClaudeCodeOtelEnv(env: NodeJS.ProcessEnv): void {
  assert.equal(env[ClaudeCodeOtelEnvVar.EnableTelemetry], "1");
  assert.equal(env[ClaudeCodeOtelEnvVar.MetricsExporter], "otlp");
  assert.equal(env[ClaudeCodeOtelEnvVar.LogsExporter], "otlp");
  assert.equal(env[ClaudeCodeOtelEnvVar.OtlpProtocol], "http/protobuf");
  assert.equal(env[ClaudeCodeOtelEnvVar.OtlpEndpoint], "http://127.0.0.1:4318");
}

function assertNoClaudeCodeOtelEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.values(ClaudeCodeOtelEnvVar)) {
    assert.equal(env[key], undefined, `${key} should not be injected`);
  }
}

function assertRunLoopSpyContainsClaudeCodeOtelEnv(spyContent: string): void {
  assert.ok(
    spyContent.includes(`${ClaudeCodeOtelEnvVar.EnableTelemetry}=1`),
    `run-loop env should include telemetry enablement, got: ${spyContent}`
  );
  assert.ok(
    spyContent.includes(`${ClaudeCodeOtelEnvVar.MetricsExporter}=otlp`),
    `run-loop env should include metrics exporter, got: ${spyContent}`
  );
  assert.ok(
    spyContent.includes(`${ClaudeCodeOtelEnvVar.LogsExporter}=otlp`),
    `run-loop env should include logs exporter, got: ${spyContent}`
  );
  assert.ok(
    spyContent.includes(`${ClaudeCodeOtelEnvVar.OtlpProtocol}=http/protobuf`),
    `run-loop env should include OTLP protocol, got: ${spyContent}`
  );
  assert.ok(
    spyContent.includes(
      `${ClaudeCodeOtelEnvVar.OtlpEndpoint}=http://127.0.0.1:4318`
    ),
    `run-loop env should include OTLP endpoint, got: ${spyContent}`
  );
}

function sizeOfJson(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function buildRelayEnvelope(
  loopBody: Record<string, unknown>
): Record<string, unknown> {
  return {
    targetId: "019e0-loop-target",
    operation: {
      protocolVersion: "1",
      messageId: "019e0-message",
      timestamp: "2026-05-07T00:00:00.000Z",
      type: "command",
      commandId: "019e0-command",
      operationId: "symphony_loop",
      params: {
        request: {
          method: "POST",
          path: "/api/gateway/symphony/loop",
          headers: {
            "content-type": "application/json",
            "x-desktop-source": "cloud-socket",
          },
          body: { kind: "json", value: loopBody },
        },
        commandId: "019e0-command",
        lockKey: null,
        timeoutMs: null,
        requiresApproval: null,
        approvalReason: null,
      },
      streaming: false,
    },
  };
}

function buildCloudCompatibleLoopFixture(): {
  body: Record<string, unknown>;
  bodySizeBytes: number;
  envelopeSizeBytes: number;
  envelopeOverheadBytes: number;
} {
  const body = {
    loopId: "019e0-loop",
    command: "execute",
    closedLoopAuthToken: `clt_${"t".repeat(96)}`,
    apiBaseUrl: "https://api.closedloop.ai",
    artifacts: [
      {
        id: "019e0-artifact",
        type: "IMPLEMENTATION_PLAN",
        title: "Synthetic maximum relay-compatible plan",
        content: "",
        raw: {
          slug: "PLN-507",
          content: `raw-plan-${"r".repeat(24_000)}`,
        },
      },
    ],
    prompt: "Implement the approved plan with compatibility checks.",
    repo: { fullName: "closedloop-ai/closedloop-electron", branch: "main" },
    committer: { name: "Desktop User", email: "desktop@example.com" },
    artifactSlug: "PLN-507",
    parentLoopId: "019e0-parent-loop",
    parentBranchName: "main",
    parentSessionId: "019e0-parent-session",
    localRepoPath: "/Users/test/Source/closedloop-electron",
    userContext: "u".repeat(16_000),
    attachments: Array.from({ length: 3 }, (_, index) => ({
      id: `019e0-attachment-${index}`,
      filename: `attachment-${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: 1024 * (index + 1),
      signedUrl: `https://closedloop-files.s3.us-east-1.amazonaws.com/context/${index}?X-Amz-Credential=test&X-Amz-Signature=${"a".repeat(64)}`,
      signedUrlExpiresAt: "2026-05-07T01:00:00.000Z",
    })),
    additionalRepos: [
      { fullName: "closedloop-ai/symphony-alpha", branch: "main" },
      { fullName: "closedloop-ai/claude-plugins", branch: "main" },
    ],
    primaryArtifactId: "019e0-artifact",
  };

  const baseEnvelopeSize = sizeOfJson(buildRelayEnvelope(body));
  const fillerBytes = RELAY_DISPATCH_LIMIT_BYTES - baseEnvelopeSize - 2048;
  assert.ok(fillerBytes > GENERIC_JSON_LIMIT_BYTES);
  (body.artifacts[0] as { content: string }).content = "a".repeat(fillerBytes);

  const bodySizeBytes = sizeOfJson(body);
  const envelopeSizeBytes = sizeOfJson(buildRelayEnvelope(body));
  return {
    body,
    bodySizeBytes,
    envelopeSizeBytes,
    envelopeOverheadBytes: envelopeSizeBytes - bodySizeBytes,
  };
}

test("uses closedloop-ai discovery file path by default", () => {
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [os.homedir()],
    machineName: "discovery-default-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
  });

  assert.equal(
    server.getAddress().discoveryFilePath,
    path.join(os.homedir(), ".closedloop-ai", "electron-port")
  );
});

test("returns health contract with active port and CORS headers", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-test-")
  );
  tempPathsToClean.push(tmpDir);
  const discoveryFile = path.join(tmpDir, "electron-port");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getGatewayId: () => "019dd8f5-5a1a-4bce-ae72-a3c973850f81",
    getOnboardingCompleted: () => true,
    discoveryFilePath: discoveryFile,
  });
  serversToClose.push(server);
  await server.start();

  const healthResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/health`
  );
  assert.equal(healthResponse.status, 200);
  assert.equal(
    healthResponse.headers.get("access-control-allow-origin"),
    "https://app.symphony.com"
  );

  const healthBody = (await healthResponse.json()) as {
    status: string;
    port: number;
    machineName: string;
    gatewayId?: string;
    onboardingCompleted?: boolean;
  };
  assert.equal(healthBody.status, "ok");
  assert.equal(healthBody.machineName, "test-machine");
  assert.equal(healthBody.gatewayId, "019dd8f5-5a1a-4bce-ae72-a3c973850f81");
  assert.equal(healthBody.onboardingCompleted, true);
  assert.equal(healthBody.port, server.getActivePort());

  const discoveryPort = await fs.readFile(discoveryFile, "utf-8");
  assert.equal(Number(discoveryPort), server.getActivePort());
});

test("returns 204 for CORS preflight requests", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-preflight-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://staging.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "preflight-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/launch`,
    {
      method: "OPTIONS",
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://staging.symphony.com"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-headers"),
    "Content-Type,Authorization,X-Desktop-Gateway-Token,X-Desktop-Session-Token,X-Desktop-Source,X-Desktop-Force-Approval,X-Desktop-Approval-Reason"
  );
});

test("returns private-network CORS allow header for terminal-chat preflight", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-pna-preflight-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "pna-preflight-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.closedloop.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-methods"),
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-private-network"),
    "true"
  );
});

test("allows loopback origin variants for CORS preflight", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-loopback-origin-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getAllowedDirectories: () => [tmpDir],
    machineName: "loopback-origin-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:3001",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://127.0.0.1:3001"
  );
});

test("normal mode: 127.0.0.2 loopback variant echoed back in CORS preflight", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-127-2-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "loopback-127-2-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.2:8080",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://127.0.0.2:8080"
  );
});

test("normal mode: DNS name like 127.evil.com is NOT treated as loopback", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-127-evil-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "loopback-evil-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.evil.com:8080",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  // Should NOT echo back the spoofed origin -- falls back to configured origin
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
});

test("prodOriginsOnly: preflight from loopback returns configured origin, no PNA header", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-prod-loopback-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "prod-loopback-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    prodOriginsOnly: true,
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-private-network"),
    null
  );
});

test("prodOriginsOnly: preflight from configured origin returns correct CORS + PNA header", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-prod-configured-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "prod-configured-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    prodOriginsOnly: true,
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.closedloop.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-private-network"),
    "true"
  );
});

test("prodOriginsOnly: preflight from random origin returns configured origin", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-prod-random-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "prod-random-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    prodOriginsOnly: true,
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://random.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
});

test("prodOriginsOnly: loopback webAppOrigin preflight from that origin echoes it back", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-prod-loopback-webapp-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getAllowedDirectories: () => [tmpDir],
    machineName: "prod-loopback-webapp-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    prodOriginsOnly: true,
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://localhost:3000"
  );
});

test("requires gateway token when configured", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-auth-token-")
  );
  tempPathsToClean.push(tmpDir);
  const activityEvents: GatewayActivityEvent[] = [];

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getGatewayAuthToken: () => "test-gateway-token",
    getAllowedDirectories: () => [tmpDir],
    machineName: "auth-token-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    onActivityEvent: (event) => {
      activityEvents.push(event);
    },
  });
  serversToClose.push(server);
  await server.start();

  const unauthorized = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`
  );
  assert.equal(unauthorized.status, 401);
  const body = (await unauthorized.json()) as {
    error: string;
    reason?: string;
  };
  assert.equal(body.error, "unauthorized");

  const authorized = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        "x-desktop-gateway-token": "test-gateway-token",
      },
    }
  );
  assert.equal(authorized.status, 501);

  assert.equal(activityEvents.length, 2);
  assert.equal(activityEvents[0].type, "security");
  assert.equal(activityEvents[0].statusCode, 401);
  assert.equal(activityEvents[0].path, "/api/gateway/unimplemented-route");
  assert.equal(Object.hasOwn(activityEvents[0], "requestBody"), false);
  assert.equal(Object.hasOwn(activityEvents[0], "responseBody"), false);
  assert.equal(activityEvents[1].type, "request");
  assert.equal(activityEvents[1].statusCode, 501);
  assert.equal(activityEvents[1].path, "/api/gateway/unimplemented-route");
  assert.equal(Object.hasOwn(activityEvents[1], "requestBody"), false);
  assert.equal(Object.hasOwn(activityEvents[1], "responseBody"), false);
});

test("records gateway activity byte counts without raw request or response bodies", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-safe-activity-")
  );
  tempPathsToClean.push(tmpDir);
  const activityEvents: GatewayActivityEvent[] = [];
  const requestBody = JSON.stringify({
    secret: "do-not-store",
    value: "hello",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "safe-activity-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    onActivityEvent: (event) => activityEvents.push(event),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }
  );
  const responseText = await response.text();

  assert.equal(response.status, 501);
  assert.equal(activityEvents.length, 1);
  const [event] = activityEvents;
  assert.equal(event.requestSizeBytes, Buffer.byteLength(requestBody));
  assert.equal(event.responseSizeBytes, Buffer.byteLength(responseText));
  assert.equal(Object.hasOwn(event, "requestBody"), false);
  assert.equal(Object.hasOwn(event, "responseBody"), false);
});

test("keeps approval and dispatch body available while activity capture stays payload-free", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-body-preserved-")
  );
  tempPathsToClean.push(tmpDir);
  const activityEvents: GatewayActivityEvent[] = [];
  const requestBody = JSON.stringify({ approval: "body survives" });
  let approvalBody: string | null = null;

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "body-preserved-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    onActivityEvent: (event) => activityEvents.push(event),
    evaluateApproval: (request) => {
      approvalBody = request.body;
      return {
        allow: false,
        statusCode: 202,
        payload: { error: "approval required" },
      };
    },
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }
  );

  assert.equal(response.status, 202);
  assert.equal(approvalBody, requestBody);
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].detail, "approval required");
  assert.equal(Object.hasOwn(activityEvents[0], "requestBody"), false);
  assert.equal(Object.hasOwn(activityEvents[0], "responseBody"), false);
});

test("rejects oversized numeric Content-Length before dispatch with safe 413 activity", async () => {
  const activityEvents: GatewayActivityEvent[] = [];
  const router = createGatewayRouter({
    onActivityEvent: (event) => activityEvents.push(event),
    evaluateApproval: () => {
      throw new Error("approval should not run for oversized requests");
    },
  });

  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    headers: { "content-length": String(GENERIC_JSON_LIMIT_BYTES + 1) },
  });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), {
    error: "request body too large",
    code: "request_body_too_large",
    maxBytes: GENERIC_JSON_LIMIT_BYTES,
  });
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].type, "security");
  assert.equal(activityEvents[0].detail, "request_body_too_large");
  assert.equal(
    activityEvents[0].requestSizeBytes,
    GENERIC_JSON_LIMIT_BYTES + 1
  );
  assert.equal(Object.hasOwn(activityEvents[0], "requestBody"), false);
  assert.equal(Object.hasOwn(activityEvents[0], "responseBody"), false);
});

test("treats malformed or absent Content-Length as absent and enforces streamed byte count", async () => {
  const acceptedBodies: string[] = [];
  const router = createGatewayRouter({
    evaluateApproval: (request) => {
      acceptedBodies.push(request.body);
      return {
        allow: false,
        statusCode: 202,
        payload: { error: "accepted under limit" },
      };
    },
  });
  const body = JSON.stringify({ ok: true });

  const malformed = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    headers: { "content-length": "not-a-number" },
    chunks: [body],
  });
  const absent = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    chunks: [body],
  });

  assert.equal(malformed.statusCode, 202);
  assert.equal(absent.statusCode, 202);
  assert.deepEqual(acceptedBodies, [body, body]);
});

test("rejects chunked gateway bodies once streamed bytes exceed the route limit", async () => {
  const activityEvents: GatewayActivityEvent[] = [];
  const router = createGatewayRouter({
    onActivityEvent: (event) => activityEvents.push(event),
    evaluateApproval: () => {
      throw new Error("approval should not run after streamed overflow");
    },
  });

  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    chunks: [Buffer.alloc(GENERIC_JSON_LIMIT_BYTES, "a"), Buffer.from("b")],
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.json().code, "request_body_too_large");
  assert.equal(
    activityEvents[0].requestSizeBytes,
    GENERIC_JSON_LIMIT_BYTES + 1
  );
});

test("accepts cloud-relay-compatible symphony loop body above the generic JSON cap", async () => {
  const fixture = buildCloudCompatibleLoopFixture();
  assert.ok(fixture.bodySizeBytes > GENERIC_JSON_LIMIT_BYTES);
  assert.ok(fixture.bodySizeBytes <= SYMPHONY_LOOP_LIMIT_BYTES);
  assert.ok(fixture.envelopeSizeBytes <= RELAY_DISPATCH_LIMIT_BYTES);
  assert.ok(fixture.envelopeOverheadBytes > 0);

  const activityEvents: GatewayActivityEvent[] = [];
  let approvalBodySize = 0;
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "loop-limit-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(os.tmpdir(), `loop-limit-${Date.now()}`),
    onActivityEvent: (event) => activityEvents.push(event),
    evaluateApproval: (request) => {
      approvalBodySize = Buffer.byteLength(request.body);
      return {
        allow: false,
        statusCode: 202,
        payload: { error: "accepted for approval" },
      };
    },
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixture.body),
    }
  );

  assert.equal(response.status, 202);
  assert.equal(approvalBodySize, fixture.bodySizeBytes);
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].requestSizeBytes, fixture.bodySizeBytes);
});

test("uses large route-specific limits for upload and run-viewer multipart routes", async () => {
  const body = Buffer.alloc(GENERIC_JSON_LIMIT_BYTES + 1, "x");
  const router = createGatewayRouter();

  const uploadResponse = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/symphony/upload/TICKET-1",
    headers: {
      "content-length": String(body.byteLength),
      "content-type": "application/json",
    },
    chunks: [body],
  });
  const runViewerResponse = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/run-viewer-extract",
    headers: {
      "content-length": String(body.byteLength),
      "content-type": "application/json",
    },
    chunks: [body],
  });

  assert.equal(uploadResponse.statusCode, 400);
  assert.equal(uploadResponse.json().error, "repo parameter is required");
  assert.equal(runViewerResponse.statusCode, 400);
  assert.equal(runViewerResponse.json().error, "Invalid form data");
});

test("counts streaming fallback responses without capturing response bodies", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-stream-activity-")
  );
  tempPathsToClean.push(tmpDir);
  const activityEvents: GatewayActivityEvent[] = [];
  const chunks = Array.from(
    { length: 25 },
    (_, index) =>
      `${JSON.stringify({ type: "text", index, content: "x".repeat(512) })}\n`
  );
  const upstream = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-ndjson");
    for (const chunk of chunks) {
      response.write(chunk);
    }
    response.end();
  });
  blockersToClose.push(upstream);
  await new Promise<void>((resolve, reject) => {
    upstream.listen(0, "127.0.0.1", () => resolve());
    upstream.once("error", reject);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "stream-activity-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    fallbackGatewayOrigin: `http://127.0.0.1:${address.port}`,
    onActivityEvent: (event) => activityEvents.push(event),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/fallback-stream`
  );
  const responseText = await response.text();

  assert.equal(response.status, 200);
  assert.equal(responseText, chunks.join(""));
  assert.equal(activityEvents.length, 1);
  assert.equal(
    activityEvents[0].responseSizeBytes,
    Buffer.byteLength(responseText)
  );
  assert.equal(Object.hasOwn(activityEvents[0], "responseBody"), false);
});

test("Desktop 413 body preserves gateway returned 413 parsing shape", async () => {
  const router = createGatewayRouter();
  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    headers: { "content-length": String(GENERIC_JSON_LIMIT_BYTES + 1) },
  });

  const terminalError = `gateway returned ${response.statusCode}: ${response.text()}`;
  const statusMatch = /^gateway returned (\d{3})/.exec(terminalError);
  const body = JSON.parse(
    terminalError.slice(terminalError.indexOf(": ") + 2)
  ) as {
    code?: string;
    maxBytes?: number;
  };

  assert.equal(statusMatch?.[1], "413");
  assert.equal(body.code, "request_body_too_large");
  assert.equal(body.maxBytes, GENERIC_JSON_LIMIT_BYTES);
});

test("rejects trusted browser origin without session token (origin-only bypass removed)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-origin-auth-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getGatewayAuthToken: () => "test-gateway-token",
    getAllowedDirectories: () => [tmpDir],
    machineName: "origin-auth-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  // Trusted origin alone is no longer sufficient — session token required
  const trusted = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        Origin: "https://app.closedloop.ai",
      },
    }
  );
  assert.equal(trusted.status, 401);

  const untrusted = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        Origin: "https://evil.example",
      },
    }
  );
  assert.equal(untrusted.status, 401);
});

test("rejects localhost browser origin without session token", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-localhost-origin-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getGatewayAuthToken: () => "test-gateway-token",
    getAllowedDirectories: () => [tmpDir],
    machineName: "localhost-origin-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const localhostOrigin = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        Origin: "http://localhost:3000",
      },
    }
  );
  assert.equal(localhostOrigin.status, 401);
});

test("rejects loopback browser request without origin or session token", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-no-origin-browser-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getGatewayAuthToken: () => "test-gateway-token",
    getAllowedDirectories: () => [tmpDir],
    machineName: "no-origin-browser-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
    }
  );

  assert.equal(response.status, 401);
});

test("keeps non-browser loopback request unauthorized without token", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-no-origin-non-browser-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getGatewayAuthToken: () => "test-gateway-token",
    getAllowedDirectories: () => [tmpDir],
    machineName: "no-origin-non-browser-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`
  );
  assert.equal(response.status, 401);
});

test("returns approval-required response when approval evaluator blocks gateway route", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-approval-gate-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "approval-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    evaluateApproval: () => ({
      allow: false,
      statusCode: 202,
      payload: {
        approvalRequired: true,
        approvalId: "approval-1",
        operationId: "health_check",
        message: "Manual approval required for health_check (high)",
      },
    }),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    approvalRequired: true,
    approvalId: "approval-1",
    operationId: "health_check",
    message: "Manual approval required for health_check (high)",
  });
});

test("supports async approval evaluation before dispatch", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-approval-async-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "approval-async-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
    evaluateApproval: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { allow: true };
    },
  });
  serversToClose.push(server);
  await server.start();

  const startedAt = Date.now();
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/sessions`
  );
  const durationMs = Date.now() - startedAt;
  assert.equal(response.status, 200);
  assert.ok(durationMs >= 25);
});

test("passes cloud approval headers into approval evaluator context", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-approval-headers-")
  );
  tempPathsToClean.push(tmpDir);
  let capturedRequest: {
    source: string | null;
    forceApproval: boolean;
    approvalReason: string | null;
  } | null = null;

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "approval-header-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
    evaluateApproval: (request) => {
      capturedRequest = {
        source: request.source,
        forceApproval: request.forceApproval,
        approvalReason: request.approvalReason,
      };
      return { allow: true };
    },
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/sessions`,
    {
      headers: {
        "x-desktop-source": "cloud-socket",
        "x-desktop-force-approval": "1",
        "x-desktop-approval-reason":
          "Manual approval requested by relay policy",
      },
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(capturedRequest, {
    source: "cloud-socket",
    forceApproval: true,
    approvalReason: "Manual approval requested by relay policy",
  });
});

test("falls back to the next configured port when preferred port is in use", async () => {
  const preferredPort = await findAvailablePort();
  const fallbackPort = await findAvailablePort([preferredPort]);

  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.listen(preferredPort, "127.0.0.1", () => resolve());
    blocker.once("error", reject);
  });
  blockersToClose.push(blocker);

  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-fallback-")
  );
  tempPathsToClean.push(tmpDir);
  const discoveryFile = path.join(tmpDir, "electron-port");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort,
    fallbackPorts: [fallbackPort],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "fallback-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: discoveryFile,
  });
  serversToClose.push(server);

  await server.start();

  assert.equal(server.getActivePort(), fallbackPort);
  const discoveryPort = await fs.readFile(discoveryFile, "utf-8");
  assert.equal(Number(discoveryPort), fallbackPort);
});

test("supports symphony sessions CRUD with contract-compatible response envelopes", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-sessions-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-a");
  const worktreePath = path.join(tmpDir, "repo-a-AI-123");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(worktreePath, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "session-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
  });
  serversToClose.push(server);
  await server.start();

  const postResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId: "AI-123",
        repoPath,
        worktreePath,
        pid: 12_345,
      }),
    }
  );
  assert.equal(postResponse.status, 200);
  assert.deepEqual(await postResponse.json(), { success: true });

  const getResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/sessions`
  );
  assert.equal(getResponse.status, 200);
  const getBody = (await getResponse.json()) as {
    sessions: Array<{ ticketId: string; repoPath: string }>;
  };
  assert.equal(getBody.sessions.length, 1);
  assert.equal(getBody.sessions[0]?.ticketId, "AI-123");
  assert.equal(getBody.sessions[0]?.repoPath, repoPath);

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/sessions?ticketId=AI-123`,
    { method: "DELETE" }
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { success: true });
});

test("rejects disallowed directories for symphony sessions writes (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-sessions-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });
  const disallowedRepoPath = path.join(tmpDir, "other", "repo");
  const disallowedWorktreePath = path.join(tmpDir, "other", "repo-AI-999");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "session-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
  });
  serversToClose.push(server);
  await server.start();

  const postResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId: "AI-999",
        repoPath: disallowedRepoPath,
        worktreePath: disallowedWorktreePath,
      }),
    }
  );

  assert.equal(postResponse.status, 403);
  assert.deepEqual(await postResponse.json(), {
    error: "directory not allowed",
  });
});

test("returns symphony status envelope for existing state file", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-status-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-status");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-status-AI-321");
  await fs.mkdir(path.join(worktreeDir, ".closedloop-ai", "work"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(worktreeDir, ".closedloop-ai", "work", "state.json"),
    JSON.stringify({
      status: "STOPPED",
      phase: "Process stopped by user",
      timestamp: "2026-02-27T00:00:00.000Z",
    }),
    "utf-8"
  );
  await fs.writeFile(
    path.join(worktreeDir, ".closedloop-ai", "work", "plan.json"),
    JSON.stringify({
      pendingTasks: [{ id: "task-2" }],
      completedTasks: [{ id: "task-1" }],
    }),
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "status-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/status/AI-321?repo=${encodeURIComponent(repoPath)}`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    exists: boolean;
    stateExists: boolean;
    status: string;
    phase: string;
    currentTaskId?: string;
    taskProgress?: { pending: number; completed: number; total: number };
    worktreeDir: string;
  };
  assert.equal(body.exists, true);
  assert.equal(body.stateExists, true);
  assert.equal(body.status, "STOPPED");
  assert.equal(body.phase, "Process stopped by user");
  assert.equal(body.currentTaskId, "task-2");
  assert.deepEqual(body.taskProgress, { pending: 1, completed: 1, total: 2 });
  assert.equal(body.worktreeDir, worktreeDir);
});

test("rejects disallowed repo paths for symphony status (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-status-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  const repoPath = path.join(tmpDir, "disallowed-repo");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "status-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/status/AI-777?repo=${encodeURIComponent(repoPath)}`
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "directory not allowed" });
});

test("marks state as stopped when killing by ticket without PID file", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-kill-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-kill");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-kill-AI-444");
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "state.json"),
    JSON.stringify({ status: "IN_PROGRESS", phase: "Running" }),
    "utf-8"
  );
  await fs.mkdir(path.join(worktreeDir, ".closedloop-ai"), { recursive: true });
  await fs.writeFile(
    path.join(worktreeDir, ".closedloop-ai", "symphony-loop.local.md"),
    "loop-state",
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "kill-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const killResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/kill`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "AI-444", repoPath }),
    }
  );
  assert.equal(killResponse.status, 200);
  assert.deepEqual(await killResponse.json(), {
    success: true,
    message: "No process to kill (no PID file), state marked as stopped",
  });

  const stateAfterKill = JSON.parse(
    await fs.readFile(path.join(workDir, "state.json"), "utf-8")
  ) as {
    status: string;
    phase: string;
  };
  assert.equal(stateAfterKill.status, "STOPPED");
  assert.equal(stateAfterKill.phase, "Process stopped by user");
  await assert.rejects(
    fs.readFile(
      path.join(worktreeDir, ".closedloop-ai", "symphony-loop.local.md"),
      "utf-8"
    )
  );
});

test("rejects disallowed repo paths for symphony kill (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-kill-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "kill-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const killResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/kill`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId: "AI-555",
        repoPath: path.join(tmpDir, "disallowed", "repo"),
      }),
    }
  );

  assert.equal(killResponse.status, 403);
  assert.deepEqual(await killResponse.json(), {
    error: "directory not allowed",
  });
});

test("returns plan content envelope for symphony plan route", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-plan-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-plan");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-plan-AI-777");
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "plan.json"),
    JSON.stringify({
      title: "Ticket AI-777",
      description: "Implement feature",
      content: "line1\\nline2",
    }),
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "plan-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/plan/AI-777?repo=${encodeURIComponent(repoPath)}`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    exists: boolean;
    planExists: boolean;
    content: string;
    worktreeDir: string;
  };
  assert.equal(body.exists, true);
  assert.equal(body.planExists, true);
  assert.equal(body.content, "line1\nline2");
  assert.equal(body.worktreeDir, worktreeDir);
});

test("supports chat history CRUD operations", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-chat-history-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-chat");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-chat-AI-888");
  await fs.mkdir(path.join(worktreeDir, ".closedloop-ai", "work"), {
    recursive: true,
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "chat-history-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const postSessionResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/chat-history/AI-888?repo=${encodeURIComponent(repoPath)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    }
  );
  assert.equal(postSessionResponse.status, 200);
  assert.deepEqual(await postSessionResponse.json(), {
    success: true,
    sessionId: "session-1",
  });

  const postMessageResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/chat-history/AI-888?repo=${encodeURIComponent(repoPath)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "m1",
          role: "user",
          content: "hello",
          timestamp: "2026-02-27T00:00:00.000Z",
        },
      }),
    }
  );
  assert.equal(postMessageResponse.status, 200);

  const getResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/chat-history/AI-888?repo=${encodeURIComponent(repoPath)}`
  );
  assert.equal(getResponse.status, 200);
  const getBody = (await getResponse.json()) as {
    sessionId?: string;
    messages: Array<{ content: string }>;
  };
  assert.equal(getBody.sessionId, "session-1");
  assert.equal(getBody.messages.length, 1);
  assert.equal(getBody.messages[0]?.content, "hello");

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/chat-history/AI-888?repo=${encodeURIComponent(repoPath)}`,
    { method: "DELETE" }
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), {
    success: true,
    message: "Chat history cleared",
  });
});

test("supports provider-scoped chat history with isolated CRUD", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-chat-provider-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-provider");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-provider-AI-900");
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "provider-scope-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const base = `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/chat-history/AI-900`;
  const repo = `repo=${encodeURIComponent(repoPath)}`;

  // POST with provider=claude → writes to chat-history-claude.json
  const postClaude = await fetch(`${base}?${repo}&provider=claude`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        id: "c1",
        role: "user",
        content: "claude msg",
        timestamp: "2026-03-11T00:00:00.000Z",
      },
    }),
  });
  assert.equal(postClaude.status, 200);

  // POST with provider=codex → writes to chat-history-codex.json
  const postCodex = await fetch(`${base}?${repo}&provider=codex`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        id: "x1",
        role: "user",
        content: "codex msg",
        timestamp: "2026-03-11T00:00:01.000Z",
      },
    }),
  });
  assert.equal(postCodex.status, 200);

  // GET with provider=claude → reads only Claude's history
  // No codex-chat-review.json yet, so codexSessionExists should be false
  const getClaude = await fetch(`${base}?${repo}&provider=claude`);
  assert.equal(getClaude.status, 200);
  const claudeBody = (await getClaude.json()) as {
    messages: Array<{ content: string }>;
    codexSessionExists: boolean;
  };
  assert.equal(claudeBody.messages.length, 1);
  assert.equal(claudeBody.messages[0]?.content, "claude msg");
  assert.equal(claudeBody.codexSessionExists, false);

  // GET with provider=codex → reads only Codex's history + codexSessionExists still false
  const getCodex = await fetch(`${base}?${repo}&provider=codex`);
  assert.equal(getCodex.status, 200);
  const codexBody = (await getCodex.json()) as {
    messages: Array<{ content: string }>;
    codexSessionExists: boolean;
  };
  assert.equal(codexBody.messages.length, 1);
  assert.equal(codexBody.messages[0]?.content, "codex msg");
  assert.equal(codexBody.codexSessionExists, false);

  // Seed a codex-chat-review.json to test scoped DELETE cleanup AND codexSessionExists=true
  await fs.writeFile(
    path.join(workDir, "codex-chat-review.json"),
    JSON.stringify({ sessionId: "review-session" }),
    "utf-8"
  );

  // GET after seeding codex-chat-review.json → codexSessionExists should now be true
  const getCodexWithSession = await fetch(`${base}?${repo}&provider=codex`);
  assert.equal(getCodexWithSession.status, 200);
  const codexWithSession = (await getCodexWithSession.json()) as {
    codexSessionExists: boolean;
  };
  assert.equal(codexWithSession.codexSessionExists, true);

  // DELETE with provider=claude → removes only chat-history-claude.json, leaves codex files
  const deleteClaude = await fetch(`${base}?${repo}&provider=claude`, {
    method: "DELETE",
  });
  assert.equal(deleteClaude.status, 200);

  // Verify codex history + review file still exist
  const getCodexAfter = await fetch(`${base}?${repo}&provider=codex`);
  const codexAfter = (await getCodexAfter.json()) as {
    messages: Array<{ content: string }>;
  };
  assert.equal(codexAfter.messages.length, 1);
  const reviewFileExists = await fs
    .access(path.join(workDir, "codex-chat-review.json"))
    .then(
      () => true,
      () => false
    );
  assert.equal(reviewFileExists, true);

  // DELETE with provider=codex → removes chat-history-codex.json AND codex-chat-review.json
  const deleteCodex = await fetch(`${base}?${repo}&provider=codex`, {
    method: "DELETE",
  });
  assert.equal(deleteCodex.status, 200);
  const reviewFileGone = await fs
    .access(path.join(workDir, "codex-chat-review.json"))
    .then(
      () => false,
      () => true
    );
  assert.equal(reviewFileGone, true);

  // DELETE without provider → blanket cleanup (backward compat)
  // Re-seed files first
  await fs.writeFile(
    path.join(workDir, "chat-history.json"),
    JSON.stringify({ messages: [], ticketId: "AI-900", repoPath }),
    "utf-8"
  );
  await fs.writeFile(
    path.join(workDir, "codex-chat.json"),
    JSON.stringify({ sessionId: "s1" }),
    "utf-8"
  );
  const deleteBlanket = await fetch(`${base}?${repo}`, { method: "DELETE" });
  assert.equal(deleteBlanket.status, 200);
  const codexChatGone = await fs
    .access(path.join(workDir, "codex-chat.json"))
    .then(
      () => false,
      () => true
    );
  assert.equal(codexChatGone, true);

  // Invalid provider → 400
  const badProvider = await fetch(`${base}?${repo}&provider=openai`);
  assert.equal(badProvider.status, 400);
});

test("returns jsonl log format when claude-output.jsonl exists", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-logs-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-logs");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-logs-AI-999");
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "claude-output.jsonl"),
    '{"type":"text","text":"a"}\n{"type":"text","text":"b"}\n',
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "logs-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/logs/AI-999?repo=${encodeURIComponent(repoPath)}&lines=1`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    format: string;
    lines?: string[];
    returnedLines?: number;
  };
  assert.equal(body.format, "jsonl");
  assert.equal(body.returnedLines, 1);
  assert.deepEqual(body.lines, ['{"type":"text","text":"b"}']);
});

test("returns judges payload when judges.json exists", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-judges-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-judges");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-judges-AI-456");
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "judges.json"),
    JSON.stringify({ score: 5, summary: "Looks good" }),
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "judges-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/judges/AI-456?repo=${encodeURIComponent(repoPath)}`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    exists: boolean;
    isMock: boolean;
    data?: { score: number };
  };
  assert.equal(body.exists, true);
  assert.equal(body.isMock, false);
  assert.equal(body.data?.score, 5);
});

test("serves attachment binary from wildcard route", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-attachments-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-attachments");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-attachments-AI-111");
  const attachmentsDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "attachments"
  );
  await fs.mkdir(attachmentsDir, { recursive: true });
  const imageFile = path.join(attachmentsDir, "image.png");
  await fs.writeFile(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "attachments-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/attachments/AI-111/image.png?repo=${encodeURIComponent(repoPath)}`
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...buffer], [0x89, 0x50, 0x4e, 0x47]);
});

test("uploads image attachments and returns file metadata", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-upload-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-upload");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-upload-AI-222");
  await fs.mkdir(path.join(worktreeDir, ".closedloop-ai", "work"), {
    recursive: true,
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "upload-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], {
      type: "image/png",
    }),
    "test.png"
  );

  const uploadResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/upload/AI-222?repo=${encodeURIComponent(
      repoPath
    )}`,
    {
      method: "POST",
      body: formData,
    }
  );
  assert.equal(uploadResponse.status, 200);
  const uploadBody = (await uploadResponse.json()) as {
    files: Array<{ originalName: string; apiUrl: string; savedName: string }>;
  };
  assert.equal(uploadBody.files.length, 1);
  assert.equal(uploadBody.files[0]?.originalName, "test.png");
  assert.equal(uploadBody.files[0]?.savedName.startsWith("chat-img-"), true);

  const attachmentResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}${uploadBody.files[0]?.apiUrl}`
  );
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("content-type"), "image/png");
});

test("returns health-check response envelope with required check structure", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-health-check-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "health-check-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      label: string;
      required: boolean;
      passed: boolean;
    }>;
    allRequiredPassed: boolean;
  };

  assert.equal(Array.isArray(body.checks), true);
  assert.equal(typeof body.allRequiredPassed, "boolean");
  assert.equal(
    body.checks.some((check) => check.id === "git"),
    true
  );
  assert.equal(
    body.checks.some((check) => check.id === "claude-cli"),
    true
  );
  assert.equal(
    body.checks.every((check) => typeof check.passed === "boolean"),
    true
  );
});

test("health-check returns 200 with worktree-dir failed when getSymphonyDir throws", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-health-unconfigured-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "health-unconfigured-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => {
      throw new SymphonyDirNotConfiguredError();
    },
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(
    response.status,
    200,
    "health-check should return 200 even when unconfigured"
  );
  const body = (await response.json()) as {
    checks: Array<{ id: string; passed: boolean; error?: string }>;
    allRequiredPassed: boolean;
  };

  const worktreeCheck = body.checks.find(
    (check) => check.id === "worktree-dir"
  );
  assert.ok(worktreeCheck, "worktree-dir check should be present");
  assert.equal(
    worktreeCheck.passed,
    false,
    "worktree-dir should fail when unconfigured"
  );
  assert.equal(worktreeCheck.error, "Not configured");
});

test("repos-config returns 503 when getSymphonyDir throws (not 500)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-repos-unconfigured-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "repos-unconfigured-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => {
      throw new SymphonyDirNotConfiguredError();
    },
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`
  );
  assert.equal(
    response.status,
    503,
    "repos should return 503 when symphony dir not configured"
  );
  const body = (await response.json()) as { error: string };
  assert.ok(
    body.error.includes("not configured"),
    "error message should mention configuration"
  );
});

test("tryAssertRepoAllowed returns path on success and error on disallowed", () => {
  const allowed = ["/allowed/dir"];

  const success = tryAssertRepoAllowed("/allowed/dir/repo", allowed);
  assert.ok("path" in success, "should return path on allowed directory");
  assert.equal((success as { path: string }).path, "/allowed/dir/repo");

  const failure = tryAssertRepoAllowed("/other/dir/repo", allowed);
  assert.ok("error" in failure, "should return error on disallowed directory");
  assert.equal((failure as { error: string; status: number }).status, 403);
});

test("tryAssertPathAllowed returns true on success and error on disallowed", () => {
  const allowed = ["/allowed/dir"];

  const success = tryAssertPathAllowed("/allowed/dir/sub", allowed);
  assert.equal(success, true, "should return true on allowed path");

  const failure = tryAssertPathAllowed("/other/dir/sub", allowed);
  assert.ok(failure !== true, "should return error on disallowed path");
  assert.equal((failure as { error: string; status: number }).status, 403);
});

test("supports repos config CRUD and settings patch", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-repos-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-configured");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "repo-configured",
      dependencies: { next: "15.0.0" },
    }),
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "repos-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
  });
  serversToClose.push(server);
  await server.start();

  const postResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repoPath, description: "test repo" }),
    }
  );
  assert.equal(postResponse.status, 200);
  const postBody = (await postResponse.json()) as {
    success: boolean;
    repo?: { path: string };
  };
  assert.equal(postBody.success, true);
  assert.equal(postBody.repo?.path.endsWith("repo-configured"), true);

  const patchResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worktreeParentDir: "~/tmp",
        worktreeParentDirConfirmed: true,
      }),
    }
  );
  assert.equal(patchResponse.status, 200);
  assert.deepEqual(await patchResponse.json(), { success: true });

  const getResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`
  );
  assert.equal(getResponse.status, 200);
  const getBody = (await getResponse.json()) as {
    repos: Array<{ path: string }>;
    settings: { worktreeParentDir?: string };
  };
  assert.equal(getBody.repos.length, 1);
  assert.equal(getBody.settings.worktreeParentDir, "~/tmp");

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos?path=${encodeURIComponent(repoPath)}`,
    { method: "DELETE" }
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { success: true });
});

test("lists directories and supports file search endpoint", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-filesystem-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-search");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await fs.mkdir(path.join(repoPath, ".git"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "src", "Widget.tsx"),
    "export const Widget = () => null;",
    "utf-8"
  );

  const worktreeDir = path.join(worktreeParent, "repo-search-AI-121");
  await fs.mkdir(path.join(worktreeDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(worktreeDir, "src", "WidgetPanel.tsx"),
    "export const WidgetPanel = () => null;",
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "filesystem-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const directoriesResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${encodeURIComponent(tmpDir)}`
  );
  assert.equal(directoriesResponse.status, 200);
  const directoriesBody = (await directoriesResponse.json()) as {
    directories: Array<{ name: string; isDirectory: boolean }>;
  };
  assert.equal(
    directoriesBody.directories.some((entry) => entry.name === "repo-search"),
    true
  );

  const searchResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/files/search?repo=${encodeURIComponent(
      repoPath
    )}&ticket=AI-121&query=Widget`
  );
  assert.equal(searchResponse.status, 200);
  const searchBody = (await searchResponse.json()) as {
    files: string[];
    truncated: boolean;
  };
  assert.equal(
    searchBody.files.some((file) => file.includes("WidgetPanel.tsx")),
    true
  );
  assert.equal(typeof searchBody.truncated, "boolean");
});

test("supports terminal chat history GET and DELETE", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-terminal-chat-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "terminal-chat-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => tmpDir,
  });
  serversToClose.push(server);
  await server.start();

  const getResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`
  );
  assert.equal(getResponse.status, 200);
  const getBody = (await getResponse.json()) as { messages: unknown[] };
  assert.equal(Array.isArray(getBody.messages), true);

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/terminal-chat`,
    {
      method: "DELETE",
    }
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { success: true });
});

test("supports ticket chat GET and DELETE with ticketId", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-ticket-chat-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "ticket-chat-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => tmpDir,
  });
  serversToClose.push(server);
  await server.start();

  const getResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/ticket-chat?ticketId=AI-200`
  );
  assert.equal(getResponse.status, 200);
  const getBody = (await getResponse.json()) as {
    ticketId?: string;
    messages: unknown[];
  };
  assert.equal(getBody.ticketId, "AI-200");
  assert.equal(Array.isArray(getBody.messages), true);

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/ticket-chat?ticketId=AI-200`,
    { method: "DELETE" }
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { success: true });
});

test("rejects disallowed repo path for ticket chat POST before spawn (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-ticket-chat-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "ticket-chat-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => tmpDir,
  });
  serversToClose.push(server);
  await server.start();

  const postResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/ticket-chat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId: "AI-333",
        message: "analyze",
        ticketContext: {
          identifier: "AI-333",
          title: "Title",
          url: "https://linear.app/ai-333",
        },
        repoPath: path.join(tmpDir, "not-allowed", "repo"),
      }),
    }
  );
  assert.equal(postResponse.status, 403);
  assert.deepEqual(await postResponse.json(), {
    error: "directory not allowed",
  });
});

test("supports run viewer chat history GET and DELETE", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-run-viewer-chat-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "run-viewer-chat-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => tmpDir,
  });
  serversToClose.push(server);
  await server.start();

  const getResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/run-viewer-chat`
  );
  assert.equal(getResponse.status, 200);
  const getBody = (await getResponse.json()) as { messages: unknown[] };
  assert.equal(Array.isArray(getBody.messages), true);

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/run-viewer-chat`,
    { method: "DELETE" }
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { success: true });
});

test("rejects disallowed run directory for run viewer chat POST (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-run-viewer-chat-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "run-viewer-chat-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => tmpDir,
  });
  serversToClose.push(server);
  await server.start();

  const postResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/run-viewer-chat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "analyze",
        runDir: path.join(tmpDir, "not-allowed"),
      }),
    }
  );

  assert.equal(postResponse.status, 403);
  assert.deepEqual(await postResponse.json(), {
    error: "directory not allowed",
  });
});

test("lists and cleans up extracted run-viewer directories", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-run-viewer-extract-")
  );
  tempPathsToClean.push(tmpDir);

  const runDir = path.join(
    os.tmpdir(),
    `run-viewer-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  );
  tempPathsToClean.push(runDir);
  await fs.mkdir(path.join(runDir, "nested"), { recursive: true });
  await fs.writeFile(
    path.join(runDir, "nested", "trace.log"),
    "hello",
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "run-viewer-extract-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const getResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/run-viewer-extract?runDir=${encodeURIComponent(
      runDir
    )}`
  );
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), { files: ["nested/trace.log"] });

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/run-viewer-extract`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runDir }),
    }
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { success: true });
  await assert.rejects(fs.stat(runDir));
});

test("validates run-viewer-extract POST multipart payload", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-run-viewer-extract-post-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "run-viewer-extract-post-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/run-viewer-extract`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "bad" }),
    }
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid form data" });
});

test("proxies unimplemented gateway routes to fallback origin when configured", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-fallback-proxy-")
  );
  tempPathsToClean.push(tmpDir);

  const upstream = http.createServer((_req, res) => {
    const payload = JSON.stringify({ proxied: true, source: "upstream" });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(payload);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.listen(0, "127.0.0.1", () => resolve());
    upstream.once("error", reject);
  });
  blockersToClose.push(upstream);

  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") {
    throw new Error("failed to resolve upstream address");
  }

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    fallbackGatewayOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    machineName: "fallback-proxy-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    proxied: true,
    source: "upstream",
  });
});

test("supports core git action routes", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-git-action-")
  );
  tempPathsToClean.push(tmpDir);
  const repoPath = path.join(tmpDir, "repo-git");
  await fs.mkdir(repoPath, { recursive: true });

  // Fake git binary: handles the subcommands the route exercises without
  // requiring a real git repository.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  rev-parse) echo "main" ;;',
    "  status) exit 0 ;;",
    "  branch)",
    '    case "$2" in',
    "      --list) exit 0 ;;",
    '      --show-current) echo "main" ;;',
    '      -a) printf "main|\\nfeature/AI-501|\\n" ;;',
    "      *) exit 0 ;;",
    "    esac",
    "    ;;",
    "  checkout) exit 0 ;;",
    "  symbolic-ref) exit 1 ;;",
    "  worktree) exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-action-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const statusResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status", repoPath }),
    }
  );
  assert.equal(statusResponse.status, 200);
  const statusBody = (await statusResponse.json()) as {
    hasChanges: boolean;
    currentBranch: string;
  };
  assert.equal(statusBody.hasChanges, false);
  assert.equal(typeof statusBody.currentBranch, "string");

  const branchResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "branch",
        branchName: "feature/AI-501",
        repoPath,
      }),
    }
  );
  assert.equal(branchResponse.status, 200);
  const branchBody = (await branchResponse.json()) as {
    success: boolean;
    branchName: string;
  };
  assert.equal(branchBody.success, true);
  assert.equal(branchBody.branchName, "feature/AI-501");

  const branchesResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git/branches?repo=${encodeURIComponent(repoPath)}`
  );
  assert.equal(branchesResponse.status, 200);
  const branchesBody = (await branchesResponse.json()) as {
    branches: Array<{ name: string }>;
  };
  assert.equal(
    branchesBody.branches.some((branch) => branch.name === "feature/AI-501"),
    true
  );
});

test("classifies git action failures with additive structured error fields", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-git-action-errors-")
  );
  tempPathsToClean.push(tmpDir);
  const repoPath = path.join(tmpDir, "repo-git-errors");
  await fs.mkdir(repoPath, { recursive: true });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  rev-parse) echo "main" ;;',
    "  add) exit 0 ;;",
    '  commit) echo "pre-commit hook: eslint failed" >&2; exit 1 ;;',
    '  push) echo "Permission denied (publickey)." >&2; exit 128 ;;',
    '  status) echo "fatal: not a git repository" >&2; exit 128 ;;',
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-action-errors-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const commitResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "commit", message: "test", repoPath }),
    }
  );
  assert.equal(commitResponse.status, 500);
  const commitBody = (await commitResponse.json()) as {
    error: string;
    code: string;
    details: {
      action: string;
      category: string;
      hookType: string;
      stderrExcerpt: string;
    };
  };
  assert.equal(commitBody.error, "Pre-commit hook failed");
  assert.equal(commitBody.code, LoopErrorCode.ProcessFailed);
  assert.equal(commitBody.details.category, "pre_commit_hook");
  assert.equal(commitBody.details.action, "commit");
  assert.equal(commitBody.details.hookType, "lint");
  assert.match(commitBody.details.stderrExcerpt, /eslint failed/);

  const pushResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "push", repoPath }),
    }
  );
  assert.equal(pushResponse.status, 500);
  const pushBody = (await pushResponse.json()) as {
    error: string;
    code: string;
    details: { action: string; category: string; stderrExcerpt: string };
  };
  assert.equal(pushBody.error, "Git push authentication failed");
  assert.equal(pushBody.code, LoopErrorCode.ProcessFailed);
  assert.equal(pushBody.details.category, "git_push_auth");
  assert.equal(pushBody.details.action, "push");
  assert.match(pushBody.details.stderrExcerpt, /Permission denied/);

  const statusResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status", repoPath }),
    }
  );
  assert.equal(statusResponse.status, 500);
  const statusBody = (await statusResponse.json()) as {
    error: string;
    code: string;
    details: {
      action: string;
      category: string;
      exitCode: number;
      stderrExcerpt: string;
    };
  };
  assert.equal(statusBody.code, LoopErrorCode.ProcessFailed);
  assert.equal(statusBody.details.category, "git_command_failed");
  assert.equal(statusBody.details.action, "status");
  assert.equal(statusBody.details.exitCode, 128);
  assert.match(statusBody.details.stderrExcerpt, /not a git repository/);
});

test("classifies pre-commit hook failures written to stdout", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-git-hook-stdout-")
  );
  tempPathsToClean.push(tmpDir);
  const repoPath = path.join(tmpDir, "repo-git-hook-stdout");
  await fs.mkdir(repoPath, { recursive: true });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  rev-parse) echo "main" ;;',
    "  add) exit 0 ;;",
    '  commit) echo "pre-commit hook: tsc type error"; exit 1 ;;',
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-hook-stdout-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const commitResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "commit", message: "test", repoPath }),
    }
  );
  assert.equal(commitResponse.status, 500);
  const commitBody = (await commitResponse.json()) as {
    error: string;
    code: string;
    details: {
      action: string;
      category: string;
      hookType: string;
      stderrExcerpt: string;
    };
  };
  assert.equal(commitBody.error, "Pre-commit hook failed");
  assert.equal(commitBody.code, LoopErrorCode.ProcessFailed);
  assert.equal(commitBody.details.category, "pre_commit_hook");
  assert.equal(commitBody.details.hookType, "typecheck");
  assert.match(commitBody.details.stderrExcerpt, /type error/);
});

test("classifies git repo policy, missing repo, and spawn failures", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-git-repo-errors-")
  );
  tempPathsToClean.push(tmpDir);
  const allowedRepoPath = path.join(tmpDir, "repo");
  await fs.mkdir(allowedRepoPath, { recursive: true });
  const missingRepoPath = path.join(tmpDir, "missing-repo");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  process.env.PATH = fakeBin;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedRepoPath, tmpDir],
    machineName: "git-repo-errors-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const missingResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status", repoPath: missingRepoPath }),
    }
  );
  assert.equal(missingResponse.status, 404);
  const missingBody = (await missingResponse.json()) as {
    error: string;
    code: string;
    details: { category: string };
  };
  assert.equal(missingBody.error, "repository not found");
  assert.equal(missingBody.code, LoopErrorCode.RepoNotFound);
  assert.equal(missingBody.details.category, "repo_not_found");

  const disallowedResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "status",
        repoPath: path.join(os.homedir(), ".ssh"),
      }),
    }
  );
  assert.equal(disallowedResponse.status, 403);
  const disallowedBody = (await disallowedResponse.json()) as {
    error: string;
    code: string;
    details: { category: string };
  };
  assert.equal(disallowedBody.error, "directory not allowed");
  assert.equal(disallowedBody.code, LoopErrorCode.RepoNotAllowed);
  assert.equal(disallowedBody.details.category, "repo_not_allowed");

  const spawnResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status", repoPath: allowedRepoPath }),
    }
  );
  assert.equal(spawnResponse.status, 500);
  const spawnBody = (await spawnResponse.json()) as {
    error: string;
    code: string;
    details: { category: string; action: string };
  };
  assert.equal(spawnBody.code, LoopErrorCode.SpawnFailed);
  assert.equal(spawnBody.details.category, "spawn_failed");
  assert.equal(spawnBody.details.action, "status");
});

test("supports git diff route for working tree changes", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-git-diff-")
  );
  tempPathsToClean.push(tmpDir);
  const repoPath = path.join(tmpDir, "repo-git-diff");
  await fs.mkdir(repoPath, { recursive: true });

  // Write the "current" file on disk (new content read directly by the route handler).
  await fs.writeFile(
    path.join(repoPath, "app.ts"),
    "export const value = 2;\n",
    "utf-8"
  );

  // Fake git binary: status reports the file as modified; show returns the old content.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  status) printf " M app.ts\\n" ;;',
    '  show) printf "export const value = 1;\\n" ;;',
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-diff-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const diffResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git/diff`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoPath,
        filePath: "app.ts",
      }),
    }
  );
  assert.equal(diffResponse.status, 200);
  const diffBody = (await diffResponse.json()) as {
    oldContent: string;
    newContent: string;
    isDeleted: boolean;
  };
  assert.equal(diffBody.oldContent.includes("value = 1"), true);
  assert.equal(diffBody.newContent.includes("value = 2"), true);
  assert.equal(diffBody.isDeleted, false);
});

test("validates git PR create request payload", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-git-pr-validate-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-pr-validate-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git/pr`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Missing repo" }),
    }
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "repoPath is required" });
});

test("rejects disallowed repo for git PR list endpoint (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-git-pr-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "git-pr-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git/pr/list?repo=${encodeURIComponent(
      path.join(tmpDir, "not-allowed", "repo")
    )}`
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "directory not allowed" });
});

test("returns empty work-directory result when no session or worktree exists", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-work-dir-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "work-dir-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/work-directory/AI-999`
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    exists: false,
    path: null,
    pendingClaudeMd: null,
    branchStatus: null,
  });
});

test("rejects disallowed workDir on aggregate symphony status route (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-status-all-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "status-all-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/status?workDir=${encodeURIComponent(
      path.join(tmpDir, "not-allowed")
    )}`
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "directory not allowed" });
});

test("detects deploy config from repo scripts", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-deploy-detect-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-deploy");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      scripts: { dev: "next dev -p 3100" },
      dependencies: { next: "15.0.0" },
    }),
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "deploy-detect-machine",
    version: "0.1.0-test",
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/deploy/detect`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath }),
    }
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    detected: boolean;
    config?: { command?: string; port?: number; framework?: string };
  };
  assert.equal(body.detected, true);
  assert.equal(body.config?.framework, "next");
  assert.equal(body.config?.port, 3100);
  assert.equal(typeof body.config?.command, "string");
});

test("rejects disallowed repo/worktree for deploy check-existing (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-deploy-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "deploy-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/deploy/check-existing`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoPath: path.join(tmpDir, "not-allowed", "repo"),
        worktreePath: path.join(tmpDir, "not-allowed", "repo-AI-1"),
      }),
    }
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "directory not allowed" });
});

test("validates required fields for symphony extract-learnings route", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-learnings-validate-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "learnings-validate-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/extract-learnings`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/repo" }),
    }
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "ticketId and repoPath are required",
  });
});

test("returns skipped status when no learnings are pending", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-learnings-process-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-learning");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(
    path.join(worktreeParent, "repo-learning-AI-101", ".closedloop-ai", "work"),
    {
      recursive: true,
    }
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "learnings-process-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/process-learnings`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "AI-101", repoPath }),
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "skipped",
    reason: "No pending learnings directory",
  });
});

test("invokes plugin cache discovery when pending learnings exist", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-learnings-plugin-")
  );
  tempPathsToClean.push(tmpDir);

  // Isolate HOME so a developer's real ~/.claude/plugins/cache never spawns a real wrapper.
  const isolatedHome = path.join(tmpDir, "isolated-home");
  await fs.mkdir(isolatedHome, { recursive: true });
  process.env.HOME = isolatedHome;

  const repoPath = path.join(tmpDir, "repo-plugin");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await fs.mkdir(repoPath, { recursive: true });
  const pendingDir = path.join(
    worktreeParent,
    "repo-plugin-PLG-01",
    ".closedloop-ai",
    "work",
    ".learnings",
    "pending"
  );
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(path.join(pendingDir, "learning-1.json"), "{}");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "learnings-plugin-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/process-learnings`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "PLG-01", repoPath }),
    }
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "processing");
  assert.equal(
    body.pid,
    null,
    "with isolated HOME and no plugin cache, no real script should spawn"
  );

  // Allow the fire-and-forget status write to complete before cleanup
  await new Promise((resolve) => setTimeout(resolve, 400));
});

test("process-learnings launches self-learning wrapper with .closedloop-ai/work as arg 1", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-learnings-wrapper-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-wrapper");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await fs.mkdir(repoPath, { recursive: true });
  const worktreeDir = path.join(worktreeParent, "repo-wrapper-LRN-01");
  const pendingDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    ".learnings",
    "pending"
  );
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(path.join(pendingDir, "learning-1.json"), "{}");

  const fakeHome = path.join(tmpDir, "fakehome");
  const pluginScriptsDir = path.join(
    fakeHome,
    ".claude",
    "plugins",
    "cache",
    "closedloop-ai",
    "self-learning",
    "1.0.0",
    "scripts"
  );
  await fs.mkdir(pluginScriptsDir, { recursive: true });

  const spyOutputFile = path.join(tmpDir, "learnings-spy.txt");
  const spyScript = [
    "#!/bin/bash",
    `echo "ARG1=$1" > "${spyOutputFile}"`,
    `echo "CLOSEDLOOP_WORKDIR=$CLOSEDLOOP_WORKDIR" >> "${spyOutputFile}"`,
    // SPY_DONE must be the last line written so the polling reader below can
    // wait for it and never observe a partially-written file (the reader would
    // otherwise break on ARG1= and miss the not-yet-appended CLOSEDLOOP_WORKDIR).
    `echo "SPY_DONE=1" >> "${spyOutputFile}"`,
    "exit 0",
  ].join("\n");
  const scriptPath = path.join(pluginScriptsDir, "process-chat-learnings.sh");
  await fs.writeFile(scriptPath, spyScript, { mode: 0o755 });

  process.env.HOME = fakeHome;

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "learnings-wrapper-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/process-learnings`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "LRN-01", repoPath }),
    }
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "processing");
  assert.equal(
    typeof body.pid,
    "number",
    "pid should be a number when wrapper is found"
  );

  const expectedClaudeWorkDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work"
  );
  let spyContent = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      spyContent = await fs.readFile(spyOutputFile, "utf-8");
      if (spyContent.includes("SPY_DONE=1")) {
        break;
      }
    } catch {
      // file not yet written
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(
    spyContent.includes("SPY_DONE=1"),
    `spy script should have recorded all arguments and env lines, got: ${spyContent}`
  );
  assert.ok(
    spyContent.includes(`ARG1=${expectedClaudeWorkDir}`),
    `wrapper should receive .closedloop-ai/work as arg 1, got: ${spyContent}`
  );
  assert.ok(
    spyContent.includes(`CLOSEDLOOP_WORKDIR=${expectedClaudeWorkDir}`),
    `CLOSEDLOOP_WORKDIR env should be .closedloop-ai/work path, got: ${spyContent}`
  );
});

test("rejects disallowed repo path for record-learning-use (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-learnings-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "learnings-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/record-learning-use`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId: "AI-202",
        repoPath: path.join(tmpDir, "not-allowed", "repo"),
        learnings: [{ summary: "Use memoization for large lists" }],
      }),
    }
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "directory not allowed" });
});

test("validates required fields for symphony chat route", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-symphony-chat-validate-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "symphony-chat-validate-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/chat/AI-909`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/repo" }),
    }
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "message and repoPath are required",
  });
});

test("validates required query params for symphony comment-chat GET", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-comment-chat-validate-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "comment-chat-validate-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/comment-chat/c-1`
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "ticketId and repo parameters are required",
  });
});

test("returns default commit message when worktree does not exist", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-commit-message-default-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-commit");
  await fs.mkdir(repoPath, { recursive: true });
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = path.join(tmpDir, "worktrees");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "commit-message-default-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/commit-message/AI-123?repo=${encodeURIComponent(
      repoPath
    )}`
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    title: "Work on AI-123",
    description: "",
    source: "default",
  });
});

test("returns empty description when claude CLI is unavailable", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-commit-claude-unavail-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-commit-noclip");
  await fs.mkdir(repoPath, { recursive: true });

  // Create a worktree directory matching the naming pattern resolveWorktreeDir
  // produces, without using a real git worktree.
  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });
  const ticketId = "CM-001";
  const worktreeDir = path.join(
    worktreeParent,
    `repo-commit-noclip-${ticketId}`
  );
  await fs.mkdir(worktreeDir, { recursive: true });

  // Create a fake bin directory with:
  //   git   -- outputs diff content so getGitDiff returns non-empty (triggering
  //            the claude call path)
  //   claude -- exits non-zero with no output (unavailable)
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  diff) printf "feature.ts | 1 +\\n+ export const x = 1;\\n" ;;',
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });

  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "commit-claude-unavail-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/commit-message/${ticketId}?repo=${encodeURIComponent(
      repoPath
    )}`
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    title: `Work on ${ticketId}`,
    description: "",
    source: "default",
  });
  // Key regression guard: description must be "", NOT a file list from git diff --stat
  assert.equal(
    body.description,
    "",
    "description must be empty, not a diff --stat file list"
  );
});

test("uses valid JSON from claude stdout even when exit code is non-zero", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-commit-nonzero-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-commit-nonzero");
  await fs.mkdir(repoPath, { recursive: true });

  // Create a worktree directory so getGitDiff is reached (no real git needed).
  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });
  const ticketId = "CM-003";
  const worktreeDir = path.join(
    worktreeParent,
    `repo-commit-nonzero-${ticketId}`
  );
  await fs.mkdir(worktreeDir, { recursive: true });

  // Create a fake bin with:
  //   git    -- outputs diff content so getGitDiff returns non-empty
  //   claude -- exits non-zero but prints valid commit JSON (spawn-over-execFile
  //             regression guard: spawn preserves stdout on non-zero exit)
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  diff) printf "feature.ts | 1 +\\n+ export const x = 1;\\n" ;;',
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  const fakeClaudeScript = [
    "#!/bin/sh",
    'echo \'{"title": "CM-003: Add feature module", "description": "- Added feature.ts export"}\'',
    "exit 1",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), fakeClaudeScript, {
    mode: 0o755,
  });

  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "commit-nonzero-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/commit-message/${ticketId}?repo=${encodeURIComponent(
      repoPath
    )}`
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  // Must parse the JSON from stdout despite non-zero exit -- this is the
  // contract that spawn preserves (execFile would discard stdout on non-zero exit).
  assert.equal(
    body.source,
    "claude",
    "source should be claude when valid JSON is parsed from stdout"
  );
  assert.equal(body.title, "CM-003: Add feature module");
  assert.equal(body.description, "- Added feature.ts export");
});

test("returns default with empty description when worktree has no diff", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-commit-nodiff-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-commit-nodiff");
  await fs.mkdir(repoPath, { recursive: true });

  // Create a worktree directory with no changes — fake git outputs nothing for
  // "diff", so getGitDiff strips the "---" separator and returns "".
  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });
  const ticketId = "CM-002";
  await fs.mkdir(path.join(worktreeParent, `repo-commit-nodiff-${ticketId}`), {
    recursive: true,
  });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    "  diff) exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "commit-nodiff-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/commit-message/${ticketId}?repo=${encodeURIComponent(
      repoPath
    )}`
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    title: `Work on ${ticketId}`,
    description: "",
    source: "default",
  });
});

test("rejects disallowed repo for symphony launch (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-launch-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "launch-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/launch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketIdentifier: "AI-123",
        repoPath: path.join(tmpDir, "not-allowed", "repo"),
      }),
    }
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "directory not allowed" });
});

test("symphony launch invokes plugin cache discovery for run-loop script", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-launch-plugin-")
  );
  tempPathsToClean.push(tmpDir);

  // Isolate HOME so a developer's real ~/.claude/plugins/cache never spawns real run-loop.sh.
  const isolatedHome = path.join(tmpDir, "isolated-home");
  await fs.mkdir(isolatedHome, { recursive: true });
  process.env.HOME = isolatedHome;

  const repoPath = path.join(tmpDir, "repo-launch");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await fs.mkdir(repoPath, { recursive: true });
  // Pre-create worktree dir so the route skips git worktree creation
  await fs.mkdir(path.join(worktreeParent, "repo-launch-LAUNCH-01"), {
    recursive: true,
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "launch-plugin-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/launch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketIdentifier: "LAUNCH-01",
        repoPath,
      }),
    }
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.success, true);
  assert.equal(body.ticketId, "LAUNCH-01");
  assert.equal(
    body.pid,
    null,
    "with isolated HOME and no plugin cache, no real run-loop should spawn"
  );
});

test("symphony launch passes .closedloop-ai/work path (not ticket ID) as first arg to run-loop.sh", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-launch-args-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-args");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await fs.mkdir(repoPath, { recursive: true });

  // Pre-create worktree dir so the route skips git worktree creation
  const worktreeDir = path.join(worktreeParent, "repo-args-ARGS-01");
  await fs.mkdir(worktreeDir, { recursive: true });

  // Create a spy script in a fake plugin cache under a temp HOME
  const fakeHome = path.join(tmpDir, "fakehome");
  const pluginScriptsDir = path.join(
    fakeHome,
    ".claude",
    "plugins",
    "cache",
    "closedloop-ai",
    "code",
    "1.0.0",
    "scripts"
  );
  await fs.mkdir(pluginScriptsDir, { recursive: true });

  const spyOutputFile = path.join(tmpDir, "spawn-spy.txt");
  const spyScript = [
    "#!/bin/bash",
    `echo "ARG1=$1" > "${spyOutputFile}"`,
    `echo "CLOSEDLOOP_WORKDIR=$CLOSEDLOOP_WORKDIR" >> "${spyOutputFile}"`,
    `echo "${ClaudeCodeOtelEnvVar.EnableTelemetry}=$${ClaudeCodeOtelEnvVar.EnableTelemetry}" >> "${spyOutputFile}"`,
    `echo "${ClaudeCodeOtelEnvVar.MetricsExporter}=$${ClaudeCodeOtelEnvVar.MetricsExporter}" >> "${spyOutputFile}"`,
    `echo "${ClaudeCodeOtelEnvVar.LogsExporter}=$${ClaudeCodeOtelEnvVar.LogsExporter}" >> "${spyOutputFile}"`,
    `echo "${ClaudeCodeOtelEnvVar.OtlpProtocol}=$${ClaudeCodeOtelEnvVar.OtlpProtocol}" >> "${spyOutputFile}"`,
    `echo "${ClaudeCodeOtelEnvVar.OtlpEndpoint}=$${ClaudeCodeOtelEnvVar.OtlpEndpoint}" >> "${spyOutputFile}"`,
    `echo "SPY_DONE=1" >> "${spyOutputFile}"`,
    "exit 0",
  ].join("\n");
  const scriptPath = path.join(pluginScriptsDir, "run-loop.sh");
  await fs.writeFile(scriptPath, spyScript, { mode: 0o755 });

  // Override HOME so findPluginScript discovers our spy script
  process.env.HOME = fakeHome;

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "launch-args-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getClaudeCodeOtelReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Ready,
      host: "127.0.0.1",
      port: 4318,
    }),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/launch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketIdentifier: "ARGS-01",
        repoPath,
      }),
    }
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.success, true);
  assert.equal(
    typeof body.pid,
    "number",
    "pid should be a number when script is found"
  );

  // Wait for the detached spy script to write its output
  const expectedClaudeWorkDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work"
  );
  let spyContent = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      spyContent = await fs.readFile(spyOutputFile, "utf-8");
      if (spyContent.includes("SPY_DONE=1")) {
        break;
      }
    } catch {
      // file not yet written
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(
    spyContent.includes("SPY_DONE=1"),
    `spy script should have recorded all arguments and env lines, got: ${spyContent}`
  );
  assert.ok(
    spyContent.includes(`ARG1=${expectedClaudeWorkDir}`),
    `first arg should be .closedloop-ai/work path, got: ${spyContent}`
  );
  assert.ok(
    spyContent.includes(`CLOSEDLOOP_WORKDIR=${expectedClaudeWorkDir}`),
    `CLOSEDLOOP_WORKDIR env should be .closedloop-ai/work path, got: ${spyContent}`
  );
  assertRunLoopSpyContainsClaudeCodeOtelEnv(spyContent);
});

test("validates required fields for codex chat route", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-codex-chat-validate-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "codex-chat-validate-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/codex/chat/AI-111`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    }
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "prompt and repoPath are required",
  });
});

test("rejects disallowed repo for codex status route (AC-049)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-codex-status-deny-")
  );
  tempPathsToClean.push(tmpDir);

  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "codex-status-deny-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/codex/status/AI-333?repo=${encodeURIComponent(
      path.join(tmpDir, "not-allowed", "repo")
    )}`
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "directory not allowed" });
});

// ---------------------------------------------------------------------------
// T4: Codex review-scoped session — saveCodexChatSession write path
//
// The /codex/chat/:ticketId read path and the review-completion write path
// both depend on spawning a real `codex` binary, which is unavailable in CI
// and unit-test environments. A full integration test would require a running
// Codex process that emits a session ID. Instead we directly test the exported
// saveCodexChatSession helper which contains the file-selection logic shared
// by both the write-on-completion (codex.ts:774) and the onSessionId callback
// (codex.ts:905). This proves chatContextId: "review" writes to
// codex-chat-review.json while the default writes to codex-chat.json.
// ---------------------------------------------------------------------------
test("saveCodexChatSession writes to review-scoped file when chatContextId is 'review'", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-codex-session-")
  );
  tempPathsToClean.push(tmpDir);

  const workDir = path.join(tmpDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });

  // Write with chatContextId: "review" → codex-chat-review.json
  await saveCodexChatSession(tmpDir, "review-sess-1", "codex", "review");
  const reviewFile = JSON.parse(
    await fs.readFile(path.join(workDir, "codex-chat-review.json"), "utf-8")
  ) as { sessionId: string };
  assert.equal(reviewFile.sessionId, "review-sess-1");

  // Default codex-chat.json should NOT exist
  const defaultExists = await fs
    .access(path.join(workDir, "codex-chat.json"))
    .then(
      () => true,
      () => false
    );
  assert.equal(defaultExists, false);

  // Write without chatContextId → codex-chat.json
  await saveCodexChatSession(tmpDir, "general-sess-1", "codex");
  const defaultFile = JSON.parse(
    await fs.readFile(path.join(workDir, "codex-chat.json"), "utf-8")
  ) as { sessionId: string };
  assert.equal(defaultFile.sessionId, "general-sess-1");

  // Review file should still have the original session
  const reviewAfter = JSON.parse(
    await fs.readFile(path.join(workDir, "codex-chat-review.json"), "utf-8")
  ) as { sessionId: string };
  assert.equal(reviewAfter.sessionId, "review-sess-1");
});

test("saveCodexChatSession is a no-op for non-codex providers", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-codex-session-noop-")
  );
  tempPathsToClean.push(tmpDir);

  const workDir = path.join(tmpDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });

  await saveCodexChatSession(tmpDir, "sess-1", "claude", "review");
  const anyFile = await fs.readdir(workDir);
  assert.equal(anyFile.length, 0);
});

// --- Review status + verdict tests ---

test("GET codex status returns sessionId when state file has one", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-status-sessionid-")
  );
  tempPathsToClean.push(tmpDir);

  // Set SYMPHONY_WORKTREE_PARENT_DIR so resolveWorktreeDir uses tmpDir as parent
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = tmpDir;

  // Create repo dir inside tmpDir (allowed directory)
  const repoDir = path.join(tmpDir, "my-repo");
  await fs.mkdir(repoDir, { recursive: true });

  // Create worktree structure: <parent>/<repoName>-<ticketId>/.closedloop-ai/work/
  const ticketId = "TEST-123";
  const worktreeDir = path.join(tmpDir, `my-repo-${ticketId}`);
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });

  // Write state file with sessionId
  const stateFile = path.join(workDir, "codex-review-codex.json");
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      status: "completed",
      pid: 12_345,
      startedAt: "2025-01-01T00:00:00Z",
      completedAt: "2025-01-01T00:01:00Z",
      exitCode: 0,
      provider: "codex",
      sessionId: "abc-session-id-123",
      config: {
        model: "o3",
        reasoningEffort: "medium",
        reviewMode: "base",
        baseBranch: "main",
      },
    })
  );

  // Write empty log
  await fs.writeFile(
    path.join(workDir, "codex-review-codex.log"),
    "review output here"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getAllowedDirectories: () => [tmpDir],
    machineName: "status-sessionid-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const res = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/codex/status/${ticketId}?repo=${encodeURIComponent(repoDir)}&provider=codex`
  );
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    hasReview: boolean;
    sessionId?: string;
    status: string;
  };
  assert.equal(data.hasReview, true);
  assert.equal(data.status, "completed");
  assert.equal(data.sessionId, "abc-session-id-123");
});

test("POST review-verdict returns 400 when sessionId is missing", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-verdict-400-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getAllowedDirectories: () => [tmpDir],
    machineName: "verdict-400-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const res = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/codex/review-verdict/TICKET-1`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: tmpDir, provider: "codex" }),
    }
  );
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "repoPath, sessionId, and provider are required");
});

test("POST review-verdict returns 400 for invalid provider", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-verdict-bad-provider-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getAllowedDirectories: () => [tmpDir],
    machineName: "verdict-bad-provider-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const res = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/codex/review-verdict/TICKET-1`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoPath: tmpDir,
        sessionId: "sess-1",
        provider: "foo",
      }),
    }
  );
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "repoPath, sessionId, and provider are required");
});

test("POST review-verdict returns 403 for disallowed repo", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-verdict-403-")
  );
  tempPathsToClean.push(tmpDir);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getAllowedDirectories: () => [tmpDir],
    machineName: "verdict-403-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const res = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/codex/review-verdict/TICKET-1`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoPath: "/not-allowed/repo",
        sessionId: "sess-1",
        provider: "codex",
      }),
    }
  );
  assert.equal(res.status, 403);
});

test("getWebAppOrigin getter takes effect on next CORS response without restart", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-live-origin-")
  );
  tempPathsToClean.push(tmpDir);

  let currentWebAppOrigin = "https://initial.example.com";

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://initial.example.com",
    getWebAppOrigin: () => currentWebAppOrigin,
    getAllowedDirectories: () => [tmpDir],
    machineName: "live-origin-test",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  // First request: should reflect initial origin
  const res1 = await fetch(`http://127.0.0.1:${server.getActivePort()}/health`);
  assert.equal(
    res1.headers.get("access-control-allow-origin"),
    "https://initial.example.com"
  );

  // Change origin via getter — no restart
  currentWebAppOrigin = "https://updated.example.com";

  // Second request: should reflect the updated origin immediately
  const res2 = await fetch(`http://127.0.0.1:${server.getActivePort()}/health`);
  assert.equal(
    res2.headers.get("access-control-allow-origin"),
    "https://updated.example.com"
  );
});

// ---------------------------------------------------------------------------
// Helper: build a minimal LocalJob for seeding JobStore
// ---------------------------------------------------------------------------

function makeTestJob(overrides: Partial<LocalJob> = {}): LocalJob {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "test-job-1",
    kind: "SYMPHONY_LOOP",
    loopId: overrides.loopId ?? "test-loop-1",
    command: "EXECUTE",
    status: "RUNNING" as LocalJobStatus,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Bug 3: /api/gateway/symphony/kill updates JobStore immediately
// ---------------------------------------------------------------------------

test("symphony/kill updates JobStore to STOPPED when killing by ticket", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-kill-jobstore-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-kill-js");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-kill-js-AI-900");
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "state.json"),
    JSON.stringify({ status: "IN_PROGRESS", phase: "Running" }),
    "utf-8"
  );

  // Seed JobStore with a RUNNING job whose worktreeDir matches the kill target
  const jobStore = new JobStore({ cwd: tmpDir, name: "test-kill-jobstore" });
  const seededJob = makeTestJob({
    id: "kill-js-job-1",
    worktreeDir,
    status: "RUNNING",
  });
  jobStore.upsert(seededJob);
  assert.equal(jobStore.listRunning().length, 1, "precondition: job is active");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "kill-jobstore-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  // Kill via ticketId + repoPath (no PID file -> noPidFile branch)
  const killResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/kill`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "AI-900", repoPath }),
    }
  );
  assert.equal(killResponse.status, 200);

  // JobStore should now have the job as STOPPED (not stale RUNNING)
  const updatedJob = jobStore.getById("kill-js-job-1");
  assert.ok(updatedJob, "job should still exist in store");
  assert.equal(
    updatedJob!.status,
    "STOPPED",
    "job status should be STOPPED after kill"
  );
  assert.ok(updatedJob!.completedAt, "completedAt should be set");
  assert.equal(
    jobStore.listRunning().length,
    0,
    "no active jobs should remain"
  );
});

// ---------------------------------------------------------------------------
// Bug 4e: Restart-fallback cancel via loop/kill
// ---------------------------------------------------------------------------

test("loop/kill uses JobStore fallback when runningLoops is empty (post-restart)", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-loopkill-fallback-")
  );
  tempPathsToClean.push(tmpDir);

  // Spawn a real process so the kill handler can find it alive
  const sleeper = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  const sleeperPid = sleeper.pid!;
  childPidsToKill.push(sleeperPid);

  // Seed JobStore with a RUNNING job that has a loopId and the sleeper PID
  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-loopkill-fallback",
  });
  const loopId = "restart-fallback-loop-1";
  const seededJob = makeTestJob({
    id: "loopkill-fb-job-1",
    loopId,
    pid: sleeperPid,
    status: "RUNNING",
  });
  jobStore.upsert(seededJob);

  // Fresh server (runningLoops map is empty since this is a new server instance)
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "loopkill-fallback-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const killResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop/kill`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loopId }),
    }
  );
  assert.equal(killResponse.status, 200);
  const killBody = (await killResponse.json()) as {
    success: boolean;
    message: string;
  };
  assert.equal(killBody.success, true);
  assert.ok(
    killBody.message.includes("restart fallback"),
    "message should mention restart fallback"
  );

  // JobStore should now have the job as CANCEL_PENDING
  const updatedJob = jobStore.getById("loopkill-fb-job-1");
  assert.ok(updatedJob, "job should still exist in store");
  assert.equal(
    updatedJob!.status,
    "CANCEL_PENDING",
    "job status should be CANCEL_PENDING"
  );

  // Process should be dead (the handler sends SIGTERM + waits + SIGKILL)
  await new Promise((resolve) => setTimeout(resolve, 500));
  let processAlive = false;
  try {
    process.kill(sleeperPid, 0);
    processAlive = true;
  } catch {
    /* dead */
  }
  assert.equal(processAlive, false, "sleeper process should be killed");
});

// ---------------------------------------------------------------------------
// Bug 5: status endpoint suppresses terminal status while process is alive
// ---------------------------------------------------------------------------

test("symphony/status returns IN_PROGRESS when state.json says COMPLETED but process is alive", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-status-alive-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-status-alive");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeDir = path.join(worktreeParent, "repo-status-alive-AI-555");
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(workDir, { recursive: true });

  // Spawn a real process so isProcessRunning returns true
  const sleeper = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  const sleeperPid = sleeper.pid!;
  childPidsToKill.push(sleeperPid);

  // Write PID file so the status handler finds the alive process
  await fs.writeFile(
    path.join(workDir, "process.pid"),
    String(sleeperPid),
    "utf-8"
  );

  // Write state.json with terminal status COMPLETED
  await fs.writeFile(
    path.join(workDir, "state.json"),
    JSON.stringify({
      status: "COMPLETED",
      phase: "Completed",
      timestamp: new Date().toISOString(),
    }),
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "status-alive-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/status/AI-555?repo=${encodeURIComponent(repoPath)}`
  );
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    exists: boolean;
    stateExists: boolean;
    status: string;
    phase: string;
    processRunning: boolean;
    pid: number;
  };
  assert.equal(body.exists, true);
  assert.equal(body.stateExists, true);
  assert.equal(
    body.processRunning,
    true,
    "process should be detected as alive"
  );
  assert.equal(body.pid, sleeperPid);
  // Key assertion: terminal status is suppressed while process is alive
  assert.equal(
    body.status,
    "IN_PROGRESS",
    "should show IN_PROGRESS, not COMPLETED, while process alive"
  );
  assert.equal(body.phase, "Running", "phase should be normalized to Running");
});

// Helper: create a minimal passing environment for health-check tests
// (fake binaries, plugin registry, repos config) and return the tmpDir.
async function createHealthCheckFixture(
  pythonBinaryContent: string | null
): Promise<{ tmpDir: string; binDir: string; symphonyDir: string }> {
  mockClosedloopPluginManifestFetch("1.0.0");

  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-python-hc-")
  );
  tempPathsToClean.push(tmpDir);

  // Create fake home dir structure
  const homeDir = path.join(tmpDir, "home");
  const binDir = path.join(tmpDir, "bin");
  const symphonyDir = path.join(tmpDir, "symphony-home");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(symphonyDir, { recursive: true });

  const pluginNames = [
    "code",
    "platform",
    "judges",
    "code-review",
    "self-learning",
  ];

  // Write fake binaries for git, claude, gh
  const fakeBinaries: [string, string][] = [
    ["git", '#!/bin/sh\necho "git version 2.40.0"'],
    [
      "claude",
      `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then
  printf '%s\\n' '${JSON.stringify(
    pluginNames.map((name) => ({
      enabled: true,
      id: `${name}@closedloop-ai`,
      scope: "user",
      version: "1.0.0",
    }))
  )}'
  exit 0
fi
echo "1.5.0"
`,
    ],
    [
      "gh",
      '#!/bin/sh\nif [ "$1" = "auth" ]; then\n  exit 0\nfi\necho "gh version 2.40.0 (2024-01-01)"\n',
    ],
    ["codex", '#!/bin/sh\necho "0.1.0"'],
  ];
  for (const [name, content] of fakeBinaries) {
    const binPath = path.join(binDir, name);
    await fs.writeFile(binPath, content, { mode: 0o755 });
  }

  // Optionally write the python3 binary
  if (pythonBinaryContent !== null) {
    const pythonPath = path.join(binDir, "python3");
    await fs.writeFile(pythonPath, pythonBinaryContent, { mode: 0o755 });
  }

  // Write installed_plugins.json so all plugin checks pass
  const pluginsDir = path.join(homeDir, ".claude", "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });

  const pluginsRecord: Record<
    string,
    Array<{ installPath: string; scope: string; version: string }>
  > = {};
  for (const name of pluginNames) {
    const installPath = path.join(tmpDir, `plugin-${name}`);
    await fs.mkdir(installPath, { recursive: true });
    pluginsRecord[`${name}@closedloop-ai`] = [
      { installPath, scope: "user", version: "1.0.0" },
    ];
  }
  await fs.writeFile(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 1, plugins: pluginsRecord }),
    "utf-8"
  );

  // Write repos.json so worktree-dir check passes
  const configDir = path.join(symphonyDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    JSON.stringify({
      settings: {
        worktreeParentDir: "/tmp/worktrees",
        worktreeParentDirConfirmed: true,
      },
    }),
    "utf-8"
  );

  return { tmpDir, binDir, symphonyDir };
}

function installHealthCheckCommandStub(options: {
  isCodeEnabled: () => boolean;
  pythonStdout?: string;
}): void {
  _setRunCommandForTesting(async (cmd, args) => {
    const binary = path.basename(cmd);
    if (binary === "git" && args[0] === "--version") {
      return { stdout: "git version 2.40.0" };
    }
    if (binary === "gh" && args[0] === "--version") {
      return { stdout: "gh version 2.40.0 (2024-01-01)" };
    }
    if (binary === "gh" && args[0] === "auth" && args[1] === "status") {
      return { stdout: "" };
    }
    if (binary === "codex" && args[0] === "--version") {
      return { stdout: "0.1.0" };
    }
    if (binary === "python3" && args[0] === "--version") {
      return { stdout: options.pythonStdout ?? "Python 3.11.0" };
    }
    if (binary === "claude" && args[0] === "--version") {
      return { stdout: "1.5.0" };
    }
    if (
      binary === "claude" &&
      args[0] === "plugin" &&
      args[1] === "list" &&
      args[2] === "--json"
    ) {
      return {
        stdout: JSON.stringify([
          {
            id: "code@closedloop-ai",
            version: "1.0.0",
            enabled: options.isCodeEnabled(),
            installPath: "/tmp/code",
            scope: "user",
          },
          {
            id: "code-review@closedloop-ai",
            version: "1.0.0",
            enabled: true,
            installPath: "/tmp/code-review",
            scope: "user",
          },
          {
            id: "judges@closedloop-ai",
            version: "1.0.0",
            enabled: true,
            installPath: "/tmp/judges",
            scope: "user",
          },
          {
            id: "platform@closedloop-ai",
            version: "1.0.0",
            enabled: true,
            installPath: "/tmp/platform",
            scope: "user",
          },
          {
            id: "self-learning@closedloop-ai",
            version: "1.0.0",
            enabled: true,
            installPath: "/tmp/self-learning",
            scope: "user",
          },
        ]),
      };
    }

    throw {
      code: "ENOENT",
      stderr: "",
      message: `unexpected ${binary} ${args.join(" ")}`,
    };
  });
}

async function startHealthCheckServer(
  tmpDir: string,
  binDir: string,
  symphonyDir: string,
  machineName: string
): Promise<DesktopGatewayServer> {
  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName,
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getBinaryPaths: () => ({
      claude: path.join(binDir, "claude"),
      codex: path.join(binDir, "codex"),
      gh: path.join(binDir, "gh"),
      git: path.join(binDir, "git"),
      python3: path.join(binDir, "python3"),
    }),
    getSymphonyDir: () => symphonyDir,
  });
  serversToClose.push(server);
  await server.start();
  return server;
}

test("health-check fails disabled required plugin without auto-enable gate", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );
  const enableCalls: string[] = [];
  installHealthCheckCommandStub({ isCodeEnabled: () => false });
  _setPluginEnableCommandForTesting(async (pluginRef) => {
    enableCalls.push(pluginRef);
    return { outcome: "success", stdout: "", elapsedMs: 1 };
  });
  const server = await startHealthCheckServer(
    tmpDir,
    binDir,
    symphonyDir,
    "plugin-disabled-no-gate"
  );

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      passed: boolean;
      error?: string;
      enableOutcome?: string;
    }>;
    allRequiredPassed: boolean;
  };

  const check = body.checks.find((entry) => entry.id === "plugin-code");
  assert.ok(check, "code plugin check should be present");
  assert.equal(check.passed, false);
  assert.equal(check.error, "Disabled");
  assert.equal(check.enableOutcome, "skipped");
  assert.equal(body.allRequiredPassed, false);
  assert.deepEqual(enableCalls, []);
});

test("health-check auto-enables disabled plugin and verifies post-state", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );
  let codeEnabled = false;
  const enableCalls: string[] = [];
  installHealthCheckCommandStub({
    isCodeEnabled: () => codeEnabled,
  });
  _setPluginEnableCommandForTesting(async (pluginRef) => {
    enableCalls.push(pluginRef);
    codeEnabled = true;
    return { outcome: "success", stdout: "", elapsedMs: 1 };
  });
  const server = await startHealthCheckServer(
    tmpDir,
    binDir,
    symphonyDir,
    "plugin-disabled-with-gate"
  );

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check?pluginAutoUpdate=1`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      passed: boolean;
      enableAttempted?: boolean;
      enableOutcome?: string;
      enablePluginIds?: string[];
    }>;
    allRequiredPassed: boolean;
  };

  const check = body.checks.find((entry) => entry.id === "plugin-code");
  assert.ok(check, "code plugin check should be present");
  assert.equal(check.passed, true);
  assert.equal(check.enableAttempted, true);
  assert.equal(check.enableOutcome, "success");
  assert.deepEqual(check.enablePluginIds, ["code@closedloop-ai"]);
  assert.equal(body.allRequiredPassed, true);
  assert.deepEqual(enableCalls, ["code@closedloop-ai"]);
});

test("health-check keeps disabled plugin failed when auto-enable command fails", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );
  const enableCalls: string[] = [];
  installHealthCheckCommandStub({
    isCodeEnabled: () => false,
  });
  _setPluginEnableCommandForTesting(async (pluginRef) => {
    enableCalls.push(pluginRef);
    return {
      outcome: "failed",
      stdout: "",
      elapsedMs: 1,
      failureReason: "command_failed",
      stderrTail: "enable failed",
    };
  });
  const server = await startHealthCheckServer(
    tmpDir,
    binDir,
    symphonyDir,
    "plugin-enable-fails"
  );

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check?pluginAutoUpdate=1`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      passed: boolean;
      enableAttempted?: boolean;
      enableOutcome?: string;
    }>;
    allRequiredPassed: boolean;
  };

  const check = body.checks.find((entry) => entry.id === "plugin-code");
  assert.ok(check, "code plugin check should be present");
  assert.equal(check.passed, false);
  assert.equal(check.enableAttempted, true);
  assert.equal(check.enableOutcome, "failed");
  assert.equal(body.allRequiredPassed, false);
  assert.deepEqual(enableCalls, ["code@closedloop-ai"]);
});

function getHealthCheckBinaryPaths(binDir: string): () => {
  claude: string;
  gh: string;
  codex: string;
  python3: string;
  git: string;
} {
  return () => ({
    claude: path.join(binDir, "claude"),
    gh: path.join(binDir, "gh"),
    codex: path.join(binDir, "codex"),
    python3: path.join(binDir, "python3"),
    git: path.join(binDir, "git"),
  });
}

function mockClosedloopPluginManifestFetch(version: string): void {
  const passthroughFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (
      url.startsWith(
        "https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/plugins/"
      )
    ) {
      return Response.json({ version });
    }

    return passthroughFetch(input, init);
  }) as typeof fetch;
}

test("python3 health check: passes for version 3.11.0 (control)", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "python-hc-control-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      required: boolean;
      passed: boolean;
      remediation?: string;
    }>;
    allRequiredPassed: boolean;
  };

  const pythonCheck = body.checks.find((c) => c.id === "python3");
  assert.ok(pythonCheck, "python3 check should be present");
  assert.equal(pythonCheck.passed, true, "python3 3.11.0 should pass");
  assert.equal(pythonCheck.required, true, "python3 check should be required");
  assert.equal(
    pythonCheck.remediation,
    undefined,
    "no remediation on passing check"
  );
  assert.equal(body.allRequiredPassed, true, "all required checks should pass");
});

test("python3 health check: fails when python3 not found", async () => {
  // Pass null to skip writing the python3 binary
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(null);

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "python-hc-notfound-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
    getBinaryPaths: getHealthCheckBinaryPaths(binDir),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      required: boolean;
      passed: boolean;
      remediation?: string;
    }>;
    allRequiredPassed: boolean;
  };

  const pythonCheck = body.checks.find((c) => c.id === "python3");
  assert.ok(pythonCheck, "python3 check should be present");
  assert.equal(pythonCheck.passed, false, "python3 not found should fail");
  assert.equal(pythonCheck.required, true, "python3 check should be required");
  // Remediation may point to the configured missing test override, an install
  // hint, or a PATH hint if a known host location is found.
  assert.ok(
    pythonCheck.remediation?.includes("Update python3 binary path") ||
      pythonCheck.remediation?.includes("Install Python 3.10 or later") ||
      pythonCheck.remediation?.includes("PATH"),
    `remediation should mention settings, install, or PATH, got: ${pythonCheck.remediation}`
  );
  assert.equal(
    body.allRequiredPassed,
    false,
    "allRequiredPassed should be false when python3 missing"
  );
});

test("python3 health check: fails for version below floor (3.9.7)", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.9.7"\n'
  );

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "python-hc-belowfloor-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
    getBinaryPaths: getHealthCheckBinaryPaths(binDir),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      required: boolean;
      passed: boolean;
      remediation?: string;
    }>;
    allRequiredPassed: boolean;
  };

  const pythonCheck = body.checks.find((c) => c.id === "python3");
  assert.ok(pythonCheck, "python3 check should be present");
  assert.equal(pythonCheck.passed, false, "python3 3.9.7 should fail");
  assert.equal(pythonCheck.required, true, "python3 check should be required");
  assert.ok(
    (pythonCheck as { error?: string }).error?.includes(
      "below the required minimum"
    ),
    "error should indicate version is below minimum"
  );
  assert.ok(
    pythonCheck.remediation?.includes("Install Python 3.10 or later"),
    "remediation should mention Install Python 3.10 or later"
  );
  assert.equal(
    body.allRequiredPassed,
    false,
    "allRequiredPassed should be false for below-floor python"
  );
});

test("python3 health check: fails for suffixed below-floor version (3.9rc1)", async () => {
  // This exercises the NaN-via-split path that the regex fix closes:
  // VERSION_REGEX captures "3.9rc1" as a valid version, but Number("9rc1") === NaN
  // and NaN < 10 is false, so the old split(".").map(Number) code would have passed this.
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.9rc1"\n'
  );

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "python-hc-suffixed-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
    getBinaryPaths: getHealthCheckBinaryPaths(binDir),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      required: boolean;
      passed: boolean;
      remediation?: string;
    }>;
    allRequiredPassed: boolean;
  };

  const pythonCheck = body.checks.find((c) => c.id === "python3");
  assert.ok(pythonCheck, "python3 check should be present");
  assert.equal(pythonCheck.passed, false, "python3 3.9rc1 should fail");
  assert.equal(pythonCheck.required, true, "python3 check should be required");
  assert.ok(
    (pythonCheck as { error?: string }).error?.includes(
      "below the required minimum"
    ),
    "error should indicate version is below minimum, not 'Unable to determine'"
  );
  assert.ok(
    pythonCheck.remediation?.includes("Install Python 3.10 or later"),
    "remediation should mention Install Python 3.10 or later"
  );
  assert.equal(
    body.allRequiredPassed,
    false,
    "allRequiredPassed should be false for suffixed below-floor version"
  );
});

test("python3 health check: passes for version with extra suffix (3.10.1.post1)", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.10.1.post1"\n'
  );

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "python-hc-extrasuffix-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
    getBinaryPaths: getHealthCheckBinaryPaths(binDir),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      required: boolean;
      passed: boolean;
      error?: string;
      remediation?: string;
    }>;
    allRequiredPassed: boolean;
  };

  const pythonCheck = body.checks.find((c) => c.id === "python3");
  assert.ok(pythonCheck, "python3 check should be present");
  assert.equal(pythonCheck.passed, true, "python3 3.10.1.post1 should pass");
  assert.equal(pythonCheck.required, true, "python3 check should be required");
  assert.equal(pythonCheck.error, undefined, "no error on passing check");
  assert.equal(body.allRequiredPassed, true, "all required checks should pass");
});

test("python3 health check: fails for unparseable version string", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "custom-build"\n'
  );

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "python-hc-unparseable-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
    getBinaryPaths: getHealthCheckBinaryPaths(binDir),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      required: boolean;
      passed: boolean;
      error?: string;
      remediation?: string;
    }>;
    allRequiredPassed: boolean;
  };

  const pythonCheck = body.checks.find((c) => c.id === "python3");
  assert.ok(pythonCheck, "python3 check should be present");
  assert.equal(
    pythonCheck.passed,
    false,
    "unparseable python version should fail"
  );
  assert.equal(pythonCheck.required, true, "python3 check should be required");
  assert.ok(
    (pythonCheck as { error?: string }).error?.includes(
      "Unable to determine Python version"
    ),
    "error should indicate unable to determine version"
  );
  assert.equal(
    body.allRequiredPassed,
    false,
    "allRequiredPassed should be false for unparseable version"
  );
});

// ---- Phase 1 tests: claude-cli rich diagnostics ----

test("claude-cli ENOENT with no foundAt: error is Not found, remediation mentions npm install", async () => {
  // Hide the KNOWN_CLAUDE_LOCATIONS sweep so the host's installed claude
  // (e.g. /opt/homebrew/bin/claude on a developer Mac) cannot leak into the
  // foundAt[] list — this test is asserting the truly-not-installed state.
  _setKnownBinaryLocationsForTesting({ claude: [] });
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );

  // Remove the fake claude binary so ENOENT is triggered
  await fs.rm(path.join(binDir, "claude"), { force: true });

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "phase1-enoent-no-foundat",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      passed: boolean;
      error?: string;
      remediation?: string;
      debug?: { foundAt?: string[] };
    }>;
  };

  const check = body.checks.find((c) => c.id === "claude-cli");
  assert.ok(check, "claude-cli check should be present");
  assert.equal(check.passed, false);
  assert.equal(check.error, "Not found");
  assert.ok(
    check.remediation?.includes("npm install"),
    `remediation should mention npm install, got: ${check.remediation}`
  );
  _setKnownBinaryLocationsForTesting(null);
});

test("claude-cli ENOENT with foundAt: error mentions path, remediation mentions Add to PATH", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );

  // Remove claude from binDir (PATH) but place it in a known location (~/.claude/local/claude)
  await fs.rm(path.join(binDir, "claude"), { force: true });
  const homeDir = path.join(tmpDir, "home");
  const claudeLocalDir = path.join(homeDir, ".claude", "local");
  await fs.mkdir(claudeLocalDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeLocalDir, "claude"),
    '#!/bin/sh\necho "1.5.0"',
    { mode: 0o755 }
  );

  process.env.HOME = homeDir;
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "phase1-enoent-with-foundat",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      passed: boolean;
      error?: string;
      remediation?: string;
      debug?: { foundAt?: string[] };
    }>;
  };

  const check = body.checks.find((c) => c.id === "claude-cli");
  assert.ok(check, "claude-cli check should be present");
  assert.equal(check.passed, false);
  assert.ok(
    check.error?.includes("but not on PATH"),
    `error should mention 'but not on PATH', got: ${check.error}`
  );
  assert.ok(
    check.remediation?.includes("Add"),
    `remediation should mention 'Add', got: ${check.remediation}`
  );
  assert.ok(
    check.remediation?.includes("to PATH"),
    `remediation should mention 'to PATH', got: ${check.remediation}`
  );
});

test("claude-cli ETIMEDOUT: error mentions Timed out, remediation mentions terminal", async () => {
  // Mock runCommand so `claude --version` throws ETIMEDOUT immediately.
  // Avoids spawning a real process or waiting on the 3s command timeout,
  // and dodges shell-portability issues (dash on Ubuntu rejects `read -t`).
  // Match by basename because resolveBinaryFromLoginShell() may pass a full resolved path
  // (e.g. /Users/.../bin/claude) rather than the bare binary name.
  _setRunCommandForTesting(async (cmd) => {
    if (path.basename(cmd) === "claude") {
      throw { code: "ETIMEDOUT", stderr: "", message: "command timed out" };
    }
    throw { code: "ENOENT", stderr: "", message: "not found" };
  });
  try {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "desktop-gateway-etimedout-")
    );
    tempPathsToClean.push(tmpDir);
    const symphonyDir = path.join(tmpDir, "symphony-home");
    await fs.mkdir(symphonyDir, { recursive: true });

    const server = new DesktopGatewayServer({
      host: "127.0.0.1",
      preferredPort: 0,
      fallbackPorts: [0],
      webAppOrigin: "https://app.symphony.com",
      getAllowedDirectories: () => [tmpDir],
      machineName: "phase1-etimedout",
      version: "0.1.0-test",
      capabilities: EMPTY_CAPABILITIES,
      discoveryFilePath: path.join(tmpDir, "electron-port"),
      getSymphonyDir: () => symphonyDir,
    });
    serversToClose.push(server);
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      checks: Array<{
        id: string;
        passed: boolean;
        error?: string;
        remediation?: string;
      }>;
    };

    const check = body.checks.find((c) => c.id === "claude-cli");
    assert.ok(check, "claude-cli check should be present");
    assert.equal(check.passed, false);
    assert.ok(
      check.error?.includes("Timed out"),
      `error should mention Timed out, got: ${check.error}`
    );
    assert.ok(
      check.remediation?.includes("terminal"),
      `remediation should mention terminal, got: ${check.remediation}`
    );
  } finally {
    _setRunCommandForTesting();
  }
});

test("KNOWN_CLAUDE_LOCATIONS probe: fake binary at known location appears in foundAt", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );

  // Remove claude from PATH
  await fs.rm(path.join(binDir, "claude"), { force: true });

  // Place claude at ~/.volta/bin/claude (a KNOWN_CLAUDE_LOCATIONS entry)
  const homeDir = path.join(tmpDir, "home");
  const voltaBinDir = path.join(homeDir, ".volta", "bin");
  await fs.mkdir(voltaBinDir, { recursive: true });
  await fs.writeFile(
    path.join(voltaBinDir, "claude"),
    '#!/bin/sh\necho "1.5.0"',
    { mode: 0o755 }
  );

  process.env.HOME = homeDir;
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "phase1-known-locations",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      passed: boolean;
      debug?: { foundAt?: string[] };
    }>;
  };

  const check = body.checks.find((c) => c.id === "claude-cli");
  assert.ok(check, "claude-cli check should be present");
  assert.equal(check.passed, false);
  assert.ok(
    Array.isArray(check.debug?.foundAt),
    "debug.foundAt should be an array"
  );
  assert.ok(
    check.debug?.foundAt?.some((p) => p.includes(".volta")),
    `foundAt should include the volta path, got: ${JSON.stringify(check.debug?.foundAt)}`
  );
});

test("claude-cli EACCES with foundAt: error mentions not executable, remediation mentions chmod +x", async () => {
  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );

  // Make the claude binary on PATH non-executable so execFileAsync fails with EACCES.
  // Note: fs.writeFile({ mode }) only applies when creating a new file; since the fixture
  // already created claude with 0o755, we must explicitly chmod it.
  const claudeOnPath = path.join(binDir, "claude");
  await fs.chmod(claudeOnPath, 0o644);

  // Place an executable claude at ~/.claude/local/claude (a KNOWN_CLAUDE_LOCATIONS entry)
  // so that collectBinaryDebug finds it and populates foundAt
  const homeDir = path.join(tmpDir, "home");
  const claudeLocalDir = path.join(homeDir, ".claude", "local");
  await fs.mkdir(claudeLocalDir, { recursive: true });
  const knownClaudePath = path.join(claudeLocalDir, "claude");
  await fs.writeFile(knownClaudePath, '#!/bin/sh\necho "1.5.0"', {
    mode: 0o755,
  });

  process.env.HOME = homeDir;
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "phase1-eacces-with-foundat",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    checks: Array<{
      id: string;
      passed: boolean;
      error?: string;
      remediation?: string;
    }>;
  };

  const check = body.checks.find((c) => c.id === "claude-cli");
  assert.ok(check, "claude-cli check should be present");
  assert.equal(check.passed, false);
  assert.ok(
    check.error?.includes("not executable"),
    `error should mention 'not executable', got: ${check.error}`
  );
  assert.ok(
    check.remediation?.includes("chmod +x"),
    `remediation should mention 'chmod +x', got: ${check.remediation}`
  );
  // Remediation must point at the actually-broken file (claudeOnPath), not
  // the unrelated executable at knownClaudePath. Regression guard for the
  // PR review comment about preserving the failing path in EACCES diagnostics.
  assert.ok(
    check.remediation?.includes(claudeOnPath),
    `remediation should reference the non-executable path ${claudeOnPath}, got: ${check.remediation}`
  );
  assert.ok(
    !check.remediation?.includes(knownClaudePath),
    `remediation should not reference the working path ${knownClaudePath}, got: ${check.remediation}`
  );
});

// ---- Telemetry dedupe integration tests ----

test("telemetry dedupe: ENOENT health-check emits healthcheck.failure_detected with check_id=claude-cli", async () => {
  const telemetryEvents: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => telemetryEvents.push(event) });

  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );

  // Remove claude binary so ENOENT is triggered
  await fs.rm(path.join(binDir, "claude"), { force: true });

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "telemetry-dedupe-enoent-1",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
  });
  serversToClose.push(server);
  await server.start();

  await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );

  const failureEvent = telemetryEvents.find(
    (e) => e.category === "healthcheck.failure_detected"
  );
  assert.ok(
    failureEvent,
    "healthcheck.failure_detected should have been emitted"
  );
  assert.equal(failureEvent.diagnostics?.extra?.check_id, "claude-cli");
});

test("telemetry dedupe: second identical ENOENT health-check emits no additional telemetry", async () => {
  const telemetryEvents: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => telemetryEvents.push(event) });

  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );

  // Remove claude binary so ENOENT is triggered
  await fs.rm(path.join(binDir, "claude"), { force: true });

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "telemetry-dedupe-enoent-2",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
  });
  serversToClose.push(server);
  await server.start();

  // First call emits failure_detected
  await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  const countAfterFirst = telemetryEvents.filter(
    (e) => e.category === "healthcheck.failure_detected"
  ).length;
  assert.equal(
    countAfterFirst,
    1,
    "first call should emit exactly one failure_detected"
  );

  // Second call with same failure should be deduped -- no new event
  await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  const countAfterSecond = telemetryEvents.filter(
    (e) => e.category === "healthcheck.failure_detected"
  ).length;
  assert.equal(
    countAfterSecond,
    1,
    "second identical call should not emit another failure_detected (dedupe)"
  );
});

test("telemetry dedupe: health-check recovery emits healthcheck.recovered", async () => {
  const telemetryEvents: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => telemetryEvents.push(event) });

  const { tmpDir, binDir, symphonyDir } = await createHealthCheckFixture(
    '#!/bin/sh\necho "Python 3.11.0"\n'
  );

  // Start with no claude binary (ENOENT)
  const claudePath = path.join(binDir, "claude");
  await fs.rm(claudePath, { force: true });

  process.env.HOME = path.join(tmpDir, "home");
  process.env.PATH = binDir;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "telemetry-dedupe-recovery",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => symphonyDir,
  });
  serversToClose.push(server);
  await server.start();

  // First call: ENOENT -> failure_detected
  await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.ok(
    telemetryEvents.some((e) => e.category === "healthcheck.failure_detected"),
    "failure_detected should have been emitted"
  );

  // Restore claude binary
  await fs.writeFile(claudePath, '#!/bin/sh\necho "1.5.0"', { mode: 0o755 });

  // Second call: now passing -> recovered
  await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/health-check`
  );
  assert.ok(
    telemetryEvents.some((e) => e.category === "healthcheck.recovered"),
    "healthcheck.recovered should have been emitted after fix"
  );
});

async function findAvailablePort(excluded: number[] = []): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() =>
          reject(new Error("failed to resolve an available port"))
        );
        return;
      }
      const port = address.port;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (excluded.includes(port)) {
          resolve(findAvailablePort(excluded));
          return;
        }
        resolve(port);
      });
    });
  });
}
