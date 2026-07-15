import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerTerminalChatRoutes } from "../src/server/operations/terminal-chat.js";
import {
  ClaudeCodeOtelEnvVar,
  ClaudeCodeOtelReceiverState,
  createClaudeCodeShellEnvProvider,
} from "../src/server/otel/claude-code-env.js";
import type {
  ProcessManager,
  StreamingProcessHandle,
  StreamingSpawnOptions,
} from "../src/server/process-manager.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";

type CapturedResponse = {
  response: ServerResponse;
  chunks: string[];
  get statusCode(): number;
  get ended(): boolean;
};

const tempDirs: string[] = [];

afterEach(async () => {
  resetShellPathCache();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("terminal chat Claude subprocess env", () => {
  test("uses Claude Code OTel env provider for direct Claude spawns", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "terminal-chat-otel-")
    );
    tempDirs.push(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const symphonyDir = path.join(tempDir, "symphony");
    const worktreeDir = path.join(tempDir, "repo");
    await mkdir(worktreeDir, { recursive: true });
    await writeFakeClaude(fakeBin);
    await writeFile(path.join(worktreeDir, ".keep"), "", { flag: "w" });

    let capturedEnv: Record<string, string> | undefined;
    const processManager = {
      spawnStreaming: (
        options: StreamingSpawnOptions
      ): Promise<StreamingProcessHandle> => {
        capturedEnv = options.env;
        setImmediate(() => {
          options.onLine?.(
            JSON.stringify({ type: "init", sessionId: "terminal-session" })
          );
          options.onExit?.(0, null);
        });
        return Promise.resolve({ pid: 7777, process: {} as never });
      },
    } as unknown as ProcessManager;
    const dispatcher = new OperationDispatcher();
    const getClaudeShellEnv = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Ready,
        host: "127.0.0.1",
        port: 4318,
      }),
      getBaseShellEnv: async () => ({ PATH: fakeBin }),
    });
    registerTerminalChatRoutes(
      dispatcher,
      processManager,
      () => [worktreeDir],
      () => symphonyDir,
      getClaudeShellEnv
    );

    await withShellPathEnvForTest(
      { PATH: fakeBin, SHELL: "/bin/sh", HOME: tempDir },
      async () => {
        setShellPathForTest();
        await dispatchPost(dispatcher, { message: "hello" });
      }
    );

    assert.ok(capturedEnv, "expected terminal Claude spawn env to be captured");
    assert.equal(capturedEnv[ClaudeCodeOtelEnvVar.EnableTelemetry], "1");
    assert.equal(capturedEnv[ClaudeCodeOtelEnvVar.MetricsExporter], "otlp");
    assert.equal(capturedEnv[ClaudeCodeOtelEnvVar.LogsExporter], "otlp");
    assert.equal(
      capturedEnv[ClaudeCodeOtelEnvVar.OtlpProtocol],
      "http/protobuf"
    );
    assert.equal(
      capturedEnv[ClaudeCodeOtelEnvVar.OtlpEndpoint],
      "http://127.0.0.1:4318"
    );
  });
});

describe("terminal chat history persistence", () => {
  test("persists the captured Claude session id before the request resolves", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "terminal-chat-persist-")
    );
    tempDirs.push(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const symphonyDir = path.join(tempDir, "symphony");
    const worktreeDir = path.join(tempDir, "repo");
    await mkdir(worktreeDir, { recursive: true });
    await writeFakeClaude(fakeBin);
    await writeFile(path.join(worktreeDir, ".keep"), "", { flag: "w" });

    const processManager = {
      spawnStreaming: (
        options: StreamingSpawnOptions
      ): Promise<StreamingProcessHandle> => {
        // Emit the init session id, then exit, on a later macrotask turn so the
        // save is fire-and-forget relative to spawnStreaming returning. The
        // request must still not resolve until that save has landed.
        setImmediate(() => {
          options.onLine?.(
            JSON.stringify({ type: "init", sessionId: "claude-abc123" })
          );
          options.onExit?.(0, null);
        });
        return Promise.resolve({ pid: 4242, process: {} as never });
      },
    } as unknown as ProcessManager;
    const dispatcher = new OperationDispatcher();
    const getClaudeShellEnv = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Ready,
        host: "127.0.0.1",
        port: 4318,
      }),
      getBaseShellEnv: async () => ({ PATH: fakeBin }),
    });
    registerTerminalChatRoutes(
      dispatcher,
      processManager,
      () => [worktreeDir],
      () => symphonyDir,
      getClaudeShellEnv
    );

    await withShellPathEnvForTest(
      { PATH: fakeBin, SHELL: "/bin/sh", HOME: tempDir },
      async () => {
        setShellPathForTest();
        await dispatchPost(dispatcher, { message: "hello" });
      }
    );

    // No polling: dispatchPost only resolves once streamClaude's finish() has
    // drained the queued history writes. If the session-id save were still
    // fire-and-forget, this synchronous read would race (and lose to) the write.
    const historyPath = path.join(
      symphonyDir,
      "chats",
      "_terminal",
      "chat-history.json"
    );
    const saved = JSON.parse(await readFile(historyPath, "utf-8")) as {
      claudeSessionId?: string;
    };
    assert.equal(saved.claudeSessionId, "claude-abc123");
  });
});

async function dispatchPost(
  dispatcher: OperationDispatcher,
  body: unknown
): Promise<CapturedResponse> {
  const captured = makeStreamingResponse();
  const bodyString = JSON.stringify(body);
  await dispatcher.dispatch({
    method: "POST",
    pathname: "/api/gateway/terminal-chat",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.from(bodyString),
    body: bodyString,
    request: {} as IncomingMessage,
    response: captured.response,
  });
  return captured;
}

function makeStreamingResponse(): CapturedResponse {
  let statusCode = 0;
  const chunks: string[] = [];
  let ended = false;
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader() {},
    flushHeaders() {},
    socket: { setNoDelay() {} },
    write(chunk: unknown) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
      }
      return true;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
      }
      ended = true;
    },
  } as unknown as ServerResponse;

  return {
    response,
    chunks,
    get statusCode() {
      return statusCode;
    },
    get ended() {
      return ended;
    },
  };
}

async function writeFakeClaude(fakeBin: string): Promise<void> {
  await mkdir(fakeBin, { recursive: true });
  const fakeClaude = path.join(fakeBin, "claude");
  await writeFile(fakeClaude, "#!/bin/sh\nexit 0\n");
  await chmod(fakeClaude, 0o755);
}
