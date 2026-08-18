/**
 * ISS-5299 — branch coverage for terminal-chat, ticket-chat, and run-viewer-chat.
 * chat-providers and chat-backend-client branches live in chat-surfaces-ops-2.test.ts.
 *
 * Every test drives the real production handler; none replicate handler logic.
 * Unreachable branches (assertPathAllowed non-DirectoryNotAllowedError,
 * getOverrideBinaryPaths optional chain) are documented and skipped.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerRunViewerChatRoutes } from "../src/server/operations/run-viewer-chat.js";
import { registerTerminalChatRoutes } from "../src/server/operations/terminal-chat.js";
import { registerTicketChatRoutes } from "../src/server/operations/ticket-chat.js";
import {
  _setKnownBinaryLocationsForResolverTest,
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import {
  assertStreamSucceeded,
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

// ---------------------------------------------------------------------------
// Module-level constants (Ultracite: no inline regex / repeated literals).
// ---------------------------------------------------------------------------
const AUTH_ERROR_LINE = JSON.stringify({
  type: "result",
  is_error: true,
  result: "authentication_error",
});
const TEXT_DELTA_LINE = JSON.stringify({
  type: "content_block_delta",
  delta: { type: "text_delta", text: "Hello from provider!" },
});
const VALID_TC = {
  identifier: "ISS-1",
  title: "Test",
  url: "https://example.com/ISS-1",
};

// ---------------------------------------------------------------------------
// Shared setup and helpers
// ---------------------------------------------------------------------------

const { makeTempDir } = createGitOpTempDirs("iss5299-chat-ops-");

afterEach(() => {
  resetShellPathCache();
  _setKnownBinaryLocationsForResolverTest(null);
});

/** No-op shell env provider — avoids OTEL setup in streaming tests. */
const noopEnv = async (): Promise<Record<string, string>> => ({});

/**
 * Run `fn` with shell PATH locked to empty so `resolveBinaryFromLoginShell`
 * falls back immediately without spawning a login shell.
 */
function withFastShellPath<T>(fn: () => Promise<T>): Promise<T> {
  return withShellPathEnvForTest({ PATH: "" }, () => {
    _setKnownBinaryLocationsForResolverTest({ claude: [], codex: [] });
    setShellPathForTest();
    return fn();
  });
}

/** Parse newline-delimited SSE JSON from a raw body string. */
function parseEvents(rawBody: string): Record<string, unknown>[] {
  return rawBody
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// PART 1 — terminal-chat.ts
// ---------------------------------------------------------------------------

describe("terminal-chat POST validation", () => {
  test("invalid JSON body → 400 (line 57 true branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [],
      () => makeTempDir(),
      noopEnv
    );
    const r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/terminal-chat",
      body: "NOT{{JSON",
    });
    assert.equal(r.statusCode, 400);
  });

  test("non-string message → 400 (lines 62 null branch, 63 true branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [],
      () => makeTempDir(),
      noopEnv
    );
    const r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/terminal-chat",
      body: JSON.stringify({ message: 42 }),
    });
    assert.equal(r.statusCode, 400);
    assert.ok(r.rawBody.includes("message is required"));
  });

  test("no valid allowed directory → 500 (line 85 true branch)", {
    timeout: 10_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({ message: "hello" }),
      });
      assert.equal(r.statusCode, 500);
    });
  });

  test("allowed dir is a file, not a directory → 500 (line 362 false branch)", {
    timeout: 10_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const tmpDir = makeTempDir();
    const fileNotDir = path.join(tmpDir, "file.txt");
    await writeFile(fileNotDir, "content");
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [fileNotDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({ message: "hello" }),
      });
      assert.equal(r.statusCode, 500);
    });
  });

  test("allowed dir path does not exist → 500 (line 366 catch block)", {
    timeout: 10_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => ["/tmp/iss5299-no-such-path-xyz123"],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({ message: "hello" }),
      });
      assert.equal(r.statusCode, 500);
    });
  });
});

describe("terminal-chat POST streaming paths", () => {
  test("@codex prefix routes to streamCodex (lines 394 true, 114)", {
    timeout: 15_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const workDir = makeTempDir();
    const pm = new FakeProcessManager(
      [],
      [{ lines: [JSON.stringify({ text: "codex reply" })], exitCode: 0 }]
    );
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [workDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({ message: "@codex summarise" }),
      });
      const events = parseEvents(r.rawBody);
      assertStreamSucceeded(events);
      // The scripted stdout line must actually reach the client as a `text`
      // event — otherwise this test would pass on a stream that forwarded
      // nothing at all.
      assert.ok(
        events.some((e) => e.type === "text" && e.content === "codex reply"),
        `scripted codex line was not forwarded; saw: ${JSON.stringify(events)}`
      );
    });
    assert.ok(
      pm.spawns[0].args.includes("exec"),
      "codex spawn uses exec subcommand"
    );
  });

  test("@cl prefix routes to streamClaude (line 397 true branch)", {
    timeout: 15_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const workDir = makeTempDir();
    const pm = new FakeProcessManager([], [{ lines: [], exitCode: 0 }]);
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [workDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({ message: "@cl what is 2+2" }),
      });
      const events = parseEvents(r.rawBody);
      assertStreamSucceeded(events);
    });
    assert.ok(
      !pm.spawns[0].args.includes("exec"),
      "claude spawn does not use exec"
    );
  });

  test("expectedMcpUrl string → assigned as string (line 70 true branch)", {
    timeout: 15_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const workDir = makeTempDir();
    const pm = new FakeProcessManager([], [{ lines: [], exitCode: 0 }]);
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [workDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({
          message: "hello",
          expectedMcpUrl: "http://mcp.test:3010",
        }),
      });
      assert.equal(r.statusCode, 200);
    });
  });

  test("assistant text content is pushed to history (line 175 true branch)", {
    timeout: 15_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const workDir = makeTempDir();
    const pm = new FakeProcessManager(
      [],
      [{ lines: [TEXT_DELTA_LINE], exitCode: 0 }]
    );
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [workDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({ message: "say something" }),
      });
    });
    const raw = await readFile(
      path.join(symphonyDir, "chats", "_terminal", "chat-history.json"),
      "utf-8"
    );
    const history = JSON.parse(raw) as {
      messages: { role: string; content: string }[];
    };
    assert.ok(
      history.messages.some(
        (m) =>
          m.role === "assistant" && m.content.includes("Hello from provider!")
      ),
      "assistant message should be persisted"
    );
  });

  test("pre-existing claudeSessionId adds --resume arg (line 204 true branch)", {
    timeout: 15_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const workDir = makeTempDir();
    const historyPath = path.join(
      symphonyDir,
      "chats",
      "_terminal",
      "chat-history.json"
    );
    await mkdir(path.dirname(historyPath), { recursive: true });
    await writeFile(
      historyPath,
      JSON.stringify({ messages: [], claudeSessionId: "prev-session-abc" })
    );
    const pm = new FakeProcessManager([], [{ lines: [], exitCode: 0 }]);
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [workDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({ message: "continue" }),
      });
    });
    assert.ok(
      pm.spawns[0].args.includes("--resume"),
      "spawn includes --resume"
    );
    assert.ok(
      pm.spawns[0].args.includes("prev-session-abc"),
      "spawn includes the session id"
    );
  });

  test("malformed JSON line in onLine is swallowed without crash (line 217 catch)", {
    timeout: 15_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const workDir = makeTempDir();
    const pm = new FakeProcessManager(
      [],
      [{ lines: ["this is not json!!!"], exitCode: 0 }]
    );
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [workDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({ message: "hello" }),
      });
      const events = parseEvents(r.rawBody);
      assertStreamSucceeded(events);
    });
  });

  test("auth challenge exit clears sessionId from history (lines 226-229 true branch)", {
    timeout: 15_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const workDir = makeTempDir();
    const historyPath = path.join(
      symphonyDir,
      "chats",
      "_terminal",
      "chat-history.json"
    );
    await mkdir(path.dirname(historyPath), { recursive: true });
    await writeFile(
      historyPath,
      JSON.stringify({ messages: [], claudeSessionId: "to-clear" })
    );
    const pm = new FakeProcessManager(
      [],
      [{ lines: [AUTH_ERROR_LINE], exitCode: 1 }]
    );
    const dispatcher = new OperationDispatcher();
    registerTerminalChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [workDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/terminal-chat",
        body: JSON.stringify({ message: "hello" }),
      });
    });
    const saved = JSON.parse(await readFile(historyPath, "utf-8")) as {
      claudeSessionId?: string;
    };
    assert.equal(
      saved.claudeSessionId,
      undefined,
      "sessionId cleared after auth challenge with non-zero exit"
    );
  });
});

// ---------------------------------------------------------------------------
// PART 2 — ticket-chat.ts
// ---------------------------------------------------------------------------

describe("ticket-chat GET/DELETE without ticketId", () => {
  test("GET without ticketId → 400 (line 49 true branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = new OperationDispatcher();
    registerTicketChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [],
      () => makeTempDir(),
      noopEnv
    );
    const r = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/ticket-chat",
    });
    assert.equal(r.statusCode, 400);
  });

  test("DELETE without ticketId → 400 (line 60 true branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = new OperationDispatcher();
    registerTicketChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [],
      () => makeTempDir(),
      noopEnv
    );
    const r = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: "/api/gateway/ticket-chat",
    });
    assert.equal(r.statusCode, 400);
  });
});

describe("ticket-chat POST validation", () => {
  test("invalid JSON body → 400 (line 74 true branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = new OperationDispatcher();
    registerTicketChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [],
      () => makeTempDir(),
      noopEnv
    );
    const r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/ticket-chat",
      body: "{{bad",
    });
    assert.equal(r.statusCode, 400);
  });

  test("non-string/missing required fields → 400 (lines 79,80,84,89,278)", {
    timeout: 5000,
  }, async () => {
    // Exercises null branches for ticketId (79), message (80), ticketContext (84,278), combined (89).
    const dispatcher = new OperationDispatcher();
    registerTicketChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [],
      () => makeTempDir(),
      noopEnv
    );
    // numeric ticketId → null (line 79) → validation fails (line 89)
    let r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/ticket-chat",
      body: JSON.stringify({
        ticketId: 99,
        message: "hi",
        ticketContext: VALID_TC,
      }),
    });
    assert.equal(r.statusCode, 400);

    // numeric message → null (line 80) → validation fails
    r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/ticket-chat",
      body: JSON.stringify({
        ticketId: "ISS-1",
        message: null,
        ticketContext: VALID_TC,
      }),
    });
    assert.equal(r.statusCode, 400);

    // falsy ticketContext → isTicketContext(null) returns false (line 278 true branch)
    r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/ticket-chat",
      body: JSON.stringify({
        ticketId: "ISS-1",
        message: "hi",
        ticketContext: null,
      }),
    });
    assert.equal(r.statusCode, 400);

    // object ticketContext missing required fields → isTicketContext returns false
    r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/ticket-chat",
      body: JSON.stringify({
        ticketId: "ISS-1",
        message: "hi",
        ticketContext: { foo: "bar" },
      }),
    });
    assert.equal(r.statusCode, 400);
  });

  test("repoPath not in allowed dirs → 403 (line 87 string branch + path check)", {
    timeout: 5000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const dispatcher = new OperationDispatcher();
    registerTicketChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => ["/tmp/allowed-only-iss5299"],
      () => symphonyDir,
      noopEnv
    );
    const r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/ticket-chat",
      body: JSON.stringify({
        ticketId: "ISS-1",
        message: "hi",
        ticketContext: VALID_TC,
        repoPath: "/tmp/other-not-allowed-iss5299",
      }),
    });
    assert.equal(r.statusCode, 403);
  });

  test("valid POST with repoPath uses getReadonlyCodebaseTools (lines 82,87,110,128,132)", {
    timeout: 20_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const workDir = makeTempDir();
    const pm = new FakeProcessManager([], [{ lines: [], exitCode: 0 }]);
    const dispatcher = new OperationDispatcher();
    registerTicketChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [workDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/ticket-chat",
        body: JSON.stringify({
          ticketId: "ISS-2",
          message: "explain",
          ticketContext: VALID_TC,
          repoPath: workDir,
          expectedMcpUrl: "http://mcp.test",
        }),
      });
      const events = parseEvents(r.rawBody);
      assertStreamSucceeded(events);
    });
    assert.equal(pm.spawns.length, 1);
  });

  test("valid POST without repoPath streams successfully (lines 110, 132)", {
    timeout: 20_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const pm = new FakeProcessManager([], [{ lines: [], exitCode: 0 }]);
    const dispatcher = new OperationDispatcher();
    registerTicketChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/ticket-chat",
        body: JSON.stringify({
          ticketId: "ISS-3",
          message: "help me",
          ticketContext: VALID_TC,
        }),
      });
      const events = parseEvents(r.rawBody);
      assertStreamSucceeded(events);
    });
  });
});

// ---------------------------------------------------------------------------
// PART 3 — run-viewer-chat.ts
// ---------------------------------------------------------------------------

describe("run-viewer-chat POST", () => {
  test("invalid JSON body → 400 (line 62 true branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = new OperationDispatcher();
    registerRunViewerChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [],
      () => makeTempDir(),
      noopEnv
    );
    const r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/run-viewer-chat",
      body: "BAD{",
    });
    assert.equal(r.statusCode, 400);
  });

  test("non-string message → 400 (lines 67 null branch, 73 true branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = new OperationDispatcher();
    registerRunViewerChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => [],
      () => makeTempDir(),
      noopEnv
    );
    const r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/run-viewer-chat",
      body: JSON.stringify({ message: 99 }),
    });
    assert.equal(r.statusCode, 400);
  });

  test("runDir not in allowed dirs → 403 (line 72 string branch + path check)", {
    timeout: 5000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const dispatcher = new OperationDispatcher();
    registerRunViewerChatRoutes(
      dispatcher,
      new FakeProcessManager().asProcessManager(),
      () => ["/tmp/allowed-rv-iss5299"],
      () => symphonyDir,
      noopEnv
    );
    const r = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/run-viewer-chat",
      body: JSON.stringify({
        message: "hi",
        runDir: "/tmp/not-allowed-rv-iss5299",
      }),
    });
    assert.equal(r.statusCode, 403);
  });

  test("valid POST without runDir streams response (lines 92, 119, 123)", {
    timeout: 20_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const pm = new FakeProcessManager([], [{ lines: [], exitCode: 0 }]);
    const dispatcher = new OperationDispatcher();
    registerRunViewerChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/run-viewer-chat",
        body: JSON.stringify({
          message: "what happened?",
          expectedMcpUrl: "http://mcp.test",
        }),
      });
      const events = parseEvents(r.rawBody);
      assertStreamSucceeded(events);
    });
  });

  test("valid POST with runDir (line 69 string, line 106 true branch)", {
    timeout: 20_000,
  }, async () => {
    const symphonyDir = makeTempDir();
    const workDir = makeTempDir();
    const pm = new FakeProcessManager([], [{ lines: [], exitCode: 0 }]);
    const dispatcher = new OperationDispatcher();
    registerRunViewerChatRoutes(
      dispatcher,
      pm.asProcessManager(),
      () => [workDir],
      () => symphonyDir,
      noopEnv
    );
    await withFastShellPath(async () => {
      const r = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/run-viewer-chat",
        body: JSON.stringify({
          message: "show logs",
          runDir: workDir,
          expectedMcpUrl: "http://mcp.test",
        }),
      });
      const events = parseEvents(r.rawBody);
      assertStreamSucceeded(events);
    });
    // cwd is set to path.resolve(workDir) when runDir is valid
    assert.equal(pm.spawns[0].cwd, path.resolve(workDir));
  });
});
