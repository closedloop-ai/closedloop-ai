/**
 * ISS-5299 — branch coverage for chat-providers (ClaudeProvider) and
 * chat-backend-client. Routes/handlers live in chat-surfaces-ops.test.ts.
 *
 * Every test drives the real production function; none replicate its logic.
 * Unreachable branches (forwardFromStreamEvents JSON catch, joinUrl no-slash
 * path) are noted and omitted.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type {
  CompleteTurnInput,
  UpsertTurnInput,
} from "../src/server/operations/chat-backend-client.js";
import {
  completeTurnViaBackend,
  upsertTurnViaBackend,
} from "../src/server/operations/chat-backend-client.js";
import {
  ClaudeProvider,
  type SpawnParams,
  type StreamEvent,
} from "../src/server/operations/chat-providers.js";
import type {
  ProcessManager,
  StreamingProcessHandle,
  StreamingSpawnOptions,
} from "../src/server/process-manager.js";
import {
  _setKnownBinaryLocationsForResolverTest,
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import {
  createGitOpTempDirs,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

// ---------------------------------------------------------------------------
// Module-level constants.
// ---------------------------------------------------------------------------
const RESULT_SUCCESS_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
});

/**
 * A NON-terminal stream line. `processStreamEvent` turns an `init` carrying a
 * sessionId into an enqueued `{type:"sessionId"}`, which is not in
 * `TERMINAL_EVENT_TYPES` and so must be forwarded. Pairing it with
 * `RESULT_SUCCESS_LINE` is what lets a filtering test distinguish "the terminal
 * event was filtered" from "nothing was forwarded at all".
 */
const INIT_LINE = JSON.stringify({
  type: "init",
  sessionId: "iss5299-session",
});

const UPSERT: UpsertTurnInput = {
  chatKey: "k1",
  userMessage: {
    id: "1",
    role: "user",
    content: "hi",
    timestamp: "2026-01-01T00:00:00Z",
  },
  provider: "claude",
  model: "claude-sonnet-4-5",
  sourceGatewayId: "gw-1",
};

const COMPLETE: CompleteTurnInput = {
  chatKey: "k1",
  provider: "claude",
  messages: [],
  sessionId: null,
  sessionSourceId: null,
};

// ---------------------------------------------------------------------------
// Shared setup and helpers
// ---------------------------------------------------------------------------

const { makeTempDir } = createGitOpTempDirs("iss5299-chat-ops2-");
const originalFetch: typeof globalThis.fetch = globalThis.fetch;

afterEach(() => {
  resetShellPathCache();
  _setKnownBinaryLocationsForResolverTest(null);
  globalThis.fetch = originalFetch;
});

/** No-op shell env provider — avoids OTEL setup in streaming tests. */
const noopEnv = async (): Promise<Record<string, string>> => ({});

function withFastShellPath<T>(fn: () => Promise<T>): Promise<T> {
  return withShellPathEnvForTest({ PATH: "" }, () => {
    _setKnownBinaryLocationsForResolverTest({ claude: [], codex: [] });
    setShellPathForTest();
    return fn();
  });
}

/**
 * Inline ProcessManager that calls `spawnFn` once the spawn promise has settled.
 *
 * `setImmediate`, not `queueMicrotask`: a microtask queued here runs BEFORE the
 * caller's own `await spawnStreaming(...)` continuation, so `onExit` would fire
 * before the caller could react to the resolved handle — the reverse of
 * production, where a real child cannot exit before its spawn promise resolves.
 * Deferring to the macrotask queue keeps the fake on production's lifecycle.
 */
function makeInlinePm(
  spawnFn: (opts: StreamingSpawnOptions) => void,
  pid = 1234
): ProcessManager {
  return {
    spawnStreaming: (
      opts: StreamingSpawnOptions
    ): Promise<StreamingProcessHandle> => {
      setImmediate(() => spawnFn(opts));
      return Promise.resolve({ pid, process: {} as never });
    },
    exec: () => Promise.reject(new Error("not used in these tests")),
  } as unknown as ProcessManager;
}

/** Minimal SpawnParams factory with safe defaults. */
function params(overrides: Partial<SpawnParams> = {}): SpawnParams {
  return {
    model: "claude-sonnet-4-5",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "hi",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ],
    tools: "WebSearch",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PART 4 — chat-providers.ts (ClaudeProvider internals)
// ---------------------------------------------------------------------------

describe("ClaudeProvider — resolveSpawnCwd branches", () => {
  test("file path cwd → stat succeeds, isDirectory false, returns undefined (line 76 try, 78 false)", {
    timeout: 10_000,
  }, async () => {
    const tmpDir = makeTempDir();
    const tmpFile = path.join(tmpDir, "file.txt");
    await writeFile(tmpFile, "content");
    let capturedCwd: string | undefined = "sentinel";
    const pm = makeInlinePm((opts) => {
      capturedCwd = opts.cwd;
      opts.onExit?.(0, null);
    });
    const provider = new ClaudeProvider(pm, noopEnv);
    await withFastShellPath(() =>
      provider.spawn(params({ cwd: tmpFile }), () => {})
    );
    assert.equal(
      capturedCwd,
      undefined,
      "file cwd resolves to undefined (not a directory)"
    );
  });

  test("non-existent cwd path → stat throws, catch returns undefined (line 81 catch)", {
    timeout: 10_000,
  }, async () => {
    let capturedCwd: string | undefined = "sentinel";
    const pm = makeInlinePm((opts) => {
      capturedCwd = opts.cwd;
      opts.onExit?.(0, null);
    });
    const provider = new ClaudeProvider(pm, noopEnv);
    await withFastShellPath(() =>
      provider.spawn(params({ cwd: "/no/such/path/iss5299-xyz" }), () => {})
    );
    assert.equal(
      capturedCwd,
      undefined,
      "non-existent cwd resolves to undefined"
    );
  });
});

describe("ClaudeProvider — renderHistoryPrompt branches", () => {
  test("empty messages array triggers ?? '' fallback (line 90)", {
    timeout: 10_000,
  }, async () => {
    let capturedInput: string | undefined;
    const pm = makeInlinePm((opts) => {
      capturedInput = opts.input;
      opts.onExit?.(0, null);
    });
    const provider = new ClaudeProvider(pm, noopEnv);
    await withFastShellPath(() =>
      provider.spawn(params({ messages: [] }), () => {})
    );
    assert.ok(capturedInput !== undefined, "spawn was called");
    assert.ok(
      !capturedInput.includes("undefined"),
      "no 'undefined' literal in prompt"
    );
  });

  test("2+ messages with context exercises for-loop and historyLines (lines 95, 100, 103)", {
    timeout: 10_000,
  }, async () => {
    let capturedInput: string | undefined;
    const pm = makeInlinePm((opts) => {
      capturedInput = opts.input;
      opts.onExit?.(0, null);
    });
    const provider = new ClaudeProvider(pm, noopEnv);
    await withFastShellPath(() =>
      provider.spawn(
        params({
          messages: [
            {
              id: "1",
              role: "user",
              content: "first question",
              timestamp: "2026-01-01T00:00:00Z",
            },
            {
              id: "2",
              role: "assistant",
              content: "first answer",
              timestamp: "2026-01-01T00:00:01Z",
            },
            {
              id: "3",
              role: "user",
              content: "follow-up",
              timestamp: "2026-01-01T00:00:02Z",
            },
          ],
          context: "some background context",
        }),
        () => {}
      )
    );
    assert.ok(
      capturedInput?.includes("some background context"),
      "context is included"
    );
    assert.ok(
      capturedInput?.includes("first question"),
      "history included in prompt"
    );
    assert.ok(capturedInput?.includes("follow-up"), "last message included");
  });
});

describe("ClaudeProvider — settle and stream edge cases", () => {
  test("empty model string falls back to defaultModel (line 142)", {
    timeout: 10_000,
  }, async () => {
    let capturedArgs: string[] | undefined;
    const pm = makeInlinePm((opts) => {
      capturedArgs = opts.args;
      opts.onExit?.(0, null);
    });
    const provider = new ClaudeProvider(pm, noopEnv);
    await withFastShellPath(() =>
      provider.spawn(params({ model: "" }), () => {})
    );
    assert.ok(
      capturedArgs?.includes("claude-sonnet-4-5"),
      "defaultModel used when model is empty string"
    );
  });

  test("second onExit call is short-circuited by settle guard (line 168)", {
    timeout: 10_000,
  }, async () => {
    // Calls onExit twice — first settles the promise, second hits `if (settled) return`.
    const pm: ProcessManager = {
      spawnStreaming: (
        opts: StreamingSpawnOptions
      ): Promise<StreamingProcessHandle> => {
        setImmediate(() => {
          opts.onExit?.(0, null); // settles
          opts.onExit?.(0, null); // line 168: if (settled) { return; }
        });
        return Promise.resolve({ pid: 99, process: {} as never });
      },
      exec: () => Promise.reject(new Error("n/a")),
    } as unknown as ProcessManager;
    const provider = new ClaudeProvider(pm, noopEnv);
    await withFastShellPath(async () => {
      const result = await provider.spawn(params(), () => {});
      assert.equal(result.exitCode, 0);
    });
  });

  test("result event is filtered by forwardFromStreamEvents (line 188)", {
    timeout: 10_000,
  }, async () => {
    // processStreamEvent enqueues {"type":"result",success:true}; forwardFromStreamEvents
    // checks TERMINAL_EVENT_TYPES.has("result") → true → returns without calling onEvent.
    //
    // The non-terminal INIT_LINE is scripted alongside it deliberately. Asserting
    // only that "result" is absent would stay green if onLine processing were
    // deleted, the script never delivered, or nothing forwarded at all — so the
    // test also pins that the non-terminal event DID come through, which fails
    // under every one of those regressions.
    const forwarded: StreamEvent[] = [];
    const pm = new FakeProcessManager(
      [],
      [{ lines: [INIT_LINE, RESULT_SUCCESS_LINE], exitCode: 0 }]
    );
    const provider = new ClaudeProvider(pm.asProcessManager(), noopEnv);
    await withFastShellPath(async () => {
      const result = await provider.spawn(params(), (e) => forwarded.push(e));
      assert.equal(result.exitCode, 0, "scripted spawn must succeed");
    });
    const types = forwarded.map((e) => e.type);
    assert.ok(
      types.includes("sessionId"),
      `non-terminal event must be forwarded; got: ${JSON.stringify(types)}`
    );
    assert.ok(
      !types.includes("result"),
      `"result" type must be filtered; got: ${JSON.stringify(types)}`
    );
  });

  test("non-JSON onLine line is swallowed by catch (line 213)", {
    timeout: 10_000,
  }, async () => {
    const pm = new FakeProcessManager(
      [],
      [{ lines: ["NOT JSON AT ALL", "still not json"], exitCode: 0 }]
    );
    const provider = new ClaudeProvider(pm.asProcessManager(), noopEnv);
    await withFastShellPath(async () => {
      const result = await provider.spawn(params(), () => {});
      assert.equal(
        result.exitCode,
        0,
        "completes normally despite non-JSON output"
      );
    });
  });

  test("null exitCode from onExit falls back to 1 (line 222)", {
    timeout: 10_000,
  }, async () => {
    const pm: ProcessManager = {
      spawnStreaming: (
        opts: StreamingSpawnOptions
      ): Promise<StreamingProcessHandle> => {
        queueMicrotask(() => opts.onExit?.(null, "SIGTERM"));
        return Promise.resolve({ pid: 7, process: {} as never });
      },
      exec: () => Promise.reject(new Error("n/a")),
    } as unknown as ProcessManager;
    const provider = new ClaudeProvider(pm, noopEnv);
    await withFastShellPath(async () => {
      const result = await provider.spawn(params(), () => {});
      assert.equal(result.exitCode, 1, "null exitCode ?? 1 → 1");
    });
  });
});

// ---------------------------------------------------------------------------
// PART 5 — chat-backend-client.ts
// ---------------------------------------------------------------------------

describe("upsertTurnViaBackend error branches", () => {
  test("200 with invalid JSON → catch returns error string (line 86)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response("NOT JSON", { status: 200 }));
    const result = await upsertTurnViaBackend("http://api.test", "tok", UPSERT);
    assert.equal(result.ok, false);
    const e = result as { error: string };
    assert.ok(
      e.error.includes("invalid JSON in 200 response"),
      `got: ${e.error}`
    );
  });

  test("409 with no boundProvider → 'unknown' fallback (line 102 false branch)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "conflict" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      );
    const result = await upsertTurnViaBackend("http://api.test", "tok", UPSERT);
    assert.equal(result.ok, false);
    const c = result as { conflict: boolean; boundProvider: string };
    assert.equal(c.conflict, true);
    assert.equal(c.boundProvider, "unknown");
  });

  test("409 with invalid JSON → catch returns error string (line 105)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response("bad json", { status: 409 }));
    const result = await upsertTurnViaBackend("http://api.test", "tok", UPSERT);
    assert.equal(result.ok, false);
    const e = result as { error: string };
    assert.ok(
      e.error.includes("invalid JSON in 409 response"),
      `got: ${e.error}`
    );
  });
});

describe("completeTurnViaBackend error branches", () => {
  test("200 with invalid JSON → permanent error (line 148)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response("NOT JSON", { status: 200 }));
    const result = await completeTurnViaBackend(
      "http://api.test",
      "tok",
      COMPLETE
    );
    assert.equal(result.ok, false);
    const e = result as { kind: string; message: string };
    assert.equal(e.kind, "permanent");
    assert.ok(
      e.message.includes("invalid JSON in 200 response"),
      `got: ${e.message}`
    );
  });

  test("401 with empty body → 'authentication failed' fallback (line 162)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = () => Promise.resolve(new Response("", { status: 401 }));
    const result = await completeTurnViaBackend(
      "http://api.test",
      "tok",
      COMPLETE
    );
    assert.equal(result.ok, false);
    const e = result as { kind: string; message: string };
    assert.equal(e.kind, "auth_expired");
    assert.equal(e.message, "authentication failed");
  });

  test("409 with no boundProvider → 'unknown' fallback (line 174 false branch)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "conflict" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      );
    const result = await completeTurnViaBackend(
      "http://api.test",
      "tok",
      COMPLETE
    );
    assert.equal(result.ok, false);
    const e = result as { kind: string; boundProvider: string };
    assert.equal(e.kind, "conflict");
    assert.equal(e.boundProvider, "unknown");
  });

  test("409 with invalid JSON → permanent error (line 177)", {
    timeout: 5000,
  }, async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response("bad json", { status: 409 }));
    const result = await completeTurnViaBackend(
      "http://api.test",
      "tok",
      COMPLETE
    );
    assert.equal(result.ok, false);
    const e = result as { kind: string; message: string };
    assert.equal(e.kind, "permanent");
    assert.ok(
      e.message.includes("invalid JSON in 409 response"),
      `got: ${e.message}`
    );
  });
});

describe("formatFetchError and safeReadText branches", () => {
  test("AbortError → timeout message (line 230 true branch)", {
    timeout: 5000,
  }, async () => {
    const abortErr = Object.assign(new Error("request aborted"), {
      name: "AbortError",
    });
    globalThis.fetch = () => Promise.reject(abortErr);
    const result = await upsertTurnViaBackend("http://api.test", "tok", UPSERT);
    assert.equal(result.ok, false);
    const e = result as { error: string };
    assert.ok(
      e.error.includes("timed out"),
      `expected timeout message, got: ${e.error}`
    );
  });

  test("non-Error thrown → String(err) (line 235)", {
    timeout: 5000,
  }, async () => {
    // Promise.reject with a non-Error value reaches the String(err) branch in formatFetchError.
    globalThis.fetch = () => Promise.reject("string-error-iss5299");
    const result = await upsertTurnViaBackend("http://api.test", "tok", UPSERT);
    assert.equal(result.ok, false);
    const e = result as { error: string };
    assert.equal(e.error, "string-error-iss5299");
  });

  test("response.text() throws in safeReadText → empty string (line 223 catch)", {
    timeout: 5000,
  }, async () => {
    // 500 path uses safeReadText; if .text() throws, catch returns "" → message = "500".
    globalThis.fetch = () =>
      Promise.resolve({
        status: 500,
        text: () => Promise.reject(new Error("body consumed")),
        json: () => Promise.reject(new Error("body consumed")),
      } as unknown as Response);
    const result = await completeTurnViaBackend(
      "http://api.test",
      "tok",
      COMPLETE
    );
    assert.equal(result.ok, false);
    const e = result as { kind: string; message: string };
    assert.equal(e.kind, "transient");
    assert.ok(e.message.startsWith("500"), `got: ${e.message}`);
  });
});
