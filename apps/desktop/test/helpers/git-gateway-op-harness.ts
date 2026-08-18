import { mkdtempSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, afterEach, beforeEach } from "node:test";
import type { OperationDispatcher } from "../../src/server/operation-dispatcher.js";
import type {
  ExecResult,
  ProcessManager,
} from "../../src/server/process-manager.js";
import { TestResponse } from "../gateway-server-test-doubles.js";

/**
 * Module-level unit-test harness for the desktop git gateway operations
 * (`git-branches`, `git-worktree`, `git-action`, `git-diff`).
 *
 * These operations spawn real `git` child processes through
 * {@link ProcessManager.exec}. To assert BOTH the exact argv each operation
 * constructs AND how each parses git stdout/stderr, we substitute a fake
 * ProcessManager that records every `exec` call and returns canned
 * {@link ExecResult}s from a queue — no real process is ever spawned, so there
 * is no child `error` event to handle here. Path/security checks in the
 * operations still touch the real filesystem, so a real temp directory is used
 * as the allowed sandbox root.
 */

export type ExecOptions = { timeoutMs?: number };

/**
 * Ceiling on how long `dispatchOperation` waits for a matched route to end its
 * response. Comfortably above any real handler here, but far below the runner's
 * global cap so a wedged SSE route fails with its own name attached.
 */
const FINISH_TIMEOUT_MS = 10_000;

/**
 * One scripted `spawnStreaming` result: the lines the child "emits" on stdout,
 * followed by its exit. ISS-5299 — `terminal-chat`, `ticket-chat` and
 * `run-viewer-chat` reach the process manager through `spawnStreaming`, not
 * `exec`, and `asProcessManager()` casts through `unknown`, so a missing method
 * surfaced as a runtime `spawnStreaming is not a function` rather than a type
 * error.
 */
export type StreamingScript = {
  lines?: string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  pid?: number;
};

export type RecordedSpawn = {
  command: string;
  args: string[];
  cwd?: string;
  input?: string;
};

export type RecordedExec = {
  command: string;
  args: string[];
  cwd?: string;
  options?: ExecOptions;
};

/**
 * A fake ProcessManager that records `exec` invocations and returns queued
 * results in order. Each test must queue exactly one result per expected git
 * call: when the queue is exhausted the fake THROWS rather than fabricating a
 * successful result, so a handler that issues an unexpected extra git call (or
 * a test that under-queues) fails loudly instead of silently treating a phantom
 * command as a success.
 */
export class FakeProcessManager {
  readonly calls: RecordedExec[] = [];
  readonly spawns: RecordedSpawn[] = [];
  private readonly results: ExecResult[];
  private readonly streamingScripts: StreamingScript[];

  constructor(
    results: ExecResult[] = [],
    streamingScripts: StreamingScript[] = []
  ) {
    this.results = [...results];
    this.streamingScripts = [...streamingScripts];
  }

  /**
   * Scripted stand-in for {@link ProcessManager.spawnStreaming}. Records the
   * invocation, then replays the next queued script: each line is delivered
   * through the caller's `onLine`, followed by `onExit`. Delivery is deferred to
   * the macrotask queue so callers that register handlers or write to stdin
   * after the await still observe them, mirroring a real child process.
   *
   * An exhausted queue REJECTS, as `exec` does — but be aware that, unlike
   * `exec`, that rejection is NOT a reliable test failure on its own: every
   * streaming consumer (`terminal-chat`, `ticket-chat`, `run-viewer-chat`,
   * `chat-providers`) catches it, writes an `error` event and still calls
   * `finish()`, which emits `done`. So a test whose only assertion is "a `done`
   * event arrived" passes identically against an empty queue. Assert on a
   * stream-derived observable that only the success path produces (a `result`
   * with `success: true`, a scripted `text` line, the persisted history), and
   * ideally also assert that no `error` event was emitted.
   */
  spawnStreaming(options: {
    command: string;
    args?: string[];
    cwd?: string;
    input?: string;
    onLine?: (line: string) => void;
    onError?: (error: Error) => void;
    onExit?: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
  }): Promise<{ pid: number; process: unknown }> {
    this.spawns.push({
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      input: options.input,
    });
    if (this.streamingScripts.length === 0) {
      return Promise.reject(
        new Error(
          `FakeProcessManager: no queued streaming script for spawnStreaming("${options.command}", [${(
            options.args ?? []
          ).join(", ")}]); queue is exhausted`
        )
      );
    }
    const script = this.streamingScripts.shift() as StreamingScript;
    // `setImmediate`, not `queueMicrotask`: a microtask queued here runs BEFORE
    // the caller's own `await spawnStreaming(...)` continuation, so `onExit`
    // fired before the caller could emit its post-spawn "running" event and the
    // observed SSE order was `spawning, result, running, done` — the reverse of
    // production, where a real child cannot exit before its spawn promise
    // resolves. Deferring to the macrotask queue restores
    // `spawning, running, result, done` so these suites can actually catch a
    // stream-lifecycle ordering regression.
    setImmediate(() => {
      for (const line of script.lines ?? []) {
        options.onLine?.(line);
      }
      options.onExit?.(script.exitCode ?? 0, script.signal ?? null);
    });
    return Promise.resolve({ pid: script.pid ?? 4242, process: {} });
  }

  exec(
    command: string,
    args: string[] = [],
    cwd?: string,
    options?: ExecOptions
  ): Promise<ExecResult> {
    this.calls.push({ command, args, cwd, options });
    if (this.results.length === 0) {
      return Promise.reject(
        new Error(
          `FakeProcessManager: no queued result for exec("${command}", [${args.join(
            ", "
          )}]); queue is exhausted`
        )
      );
    }
    const next = this.results.shift();
    return Promise.resolve(next as ExecResult);
  }

  /** Cast helper so the fake can stand in for the real ProcessManager type. */
  asProcessManager(): ProcessManager {
    return this as unknown as ProcessManager;
  }
}

export type CapturedResponse = {
  statusCode: number;
  body: Record<string, unknown>;
  rawBody: string;
  /**
   * The underlying double, for suites that need more than status + JSON body:
   * response headers, streamed SSE chunks, or `simulateClose()` to drive a
   * client-disconnect branch.
   */
  response: TestResponse;
};

export type DispatchInput = {
  dispatcher: OperationDispatcher;
  method: string;
  pathname: string;
  query?: Record<string, string>;
  body?: string;
  /**
   * ISS-5299 — request headers the handler reads directly (`symphony-upload`
   * and `run-viewer-extract` branch on `content-type` before touching the body).
   */
  headers?: IncomingHttpHeaders;
  /**
   * ISS-5299 — raw request-stream chunks, for the Busboy multipart routes that
   * consume `context.request` as a stream rather than reading `context.body`.
   */
  requestChunks?: Array<string | Buffer>;
};

/**
 * Drives a single request through an {@link OperationDispatcher} using a
 * captured fake {@link ServerResponse}, returning the status code and parsed
 * JSON body the operation wrote.
 */
export async function dispatchOperation(
  input: DispatchInput
): Promise<CapturedResponse> {
  const response = new TestResponse();

  // ISS-5299: a real `Readable` rather than `{} as IncomingMessage`, so the
  // multipart routes can actually consume `context.request` as a stream and the
  // routes that branch on `content-type` see a header bag.
  const request = Readable.from(input.requestChunks ?? []) as Readable & {
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  };
  request.method = input.method;
  request.url = input.pathname;
  request.headers = input.headers ?? {};
  request.socket = { remoteAddress: "127.0.0.1" };

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    query.set(key, value);
  }

  const handled = await input.dispatcher.dispatch({
    method: input.method,
    pathname: input.pathname,
    params: {},
    query,
    rawBody: Buffer.from(input.body ?? ""),
    body: input.body ?? "",
    request: request as unknown as IncomingMessage,
    response: response as unknown as ServerResponse,
  });

  // Synchronize on the response's own completion signal rather than a sleep,
  // matching `dispatchMockRequest`. A handler that already ended is left alone.
  //
  // The wait is BOUNDED: a route that matches but never ends its response —
  // precisely the risk on the SSE routes these suites drive — would otherwise
  // hang until the runner's global cap, which AGENTS.md calls out ("do not rely
  // on the test runner's default timeout to catch hangs"). Failing here names
  // the offending route instead.
  if (handled && !response.finished) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `dispatchOperation: ${input.method} ${input.pathname} matched a route but never ended its response within ${FINISH_TIMEOUT_MS}ms`
          )
        );
      }, FINISH_TIMEOUT_MS);
      response.once("finish", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  const rawBody = response.text();
  return {
    // Preserved from the previous double: an unmatched route reports 0, not
    // TestResponse's default 200.
    statusCode: handled ? response.statusCode : 0,
    rawBody,
    body: parseJsonBody(rawBody, response.headers.get("content-type")),
    response,
  };
}

/**
 * Streaming routes write newline-delimited SSE JSON, so the accumulated body is
 * legitimately not a single JSON document; those tests assert on `rawBody` or
 * the recorded chunks instead, and get `{}` here. Binary/text routes
 * (`symphony-attachments` serves `application/octet-stream`) are the same case.
 *
 * A body that was MEANT to be one JSON document but doesn't parse is a different
 * thing entirely — a real handler defect — so it throws rather than degrading to
 * `{}`. Swallowing it unconditionally made every
 * `assert.equal(res.body.<field>, undefined)` vacuous and would have let a
 * JSON-serialization regression through green.
 *
 * "Meant to be JSON" is read from the route's own `content-type`, falling back to
 * a body that opens with `{` or `[` — that shape only fails to parse when it is
 * truncated or malformed, which is exactly the regression worth failing on.
 */
function parseJsonBody(
  rawBody: string,
  contentType: string | number | readonly string[] | undefined
): Record<string, unknown> {
  if (!rawBody) {
    return {};
  }
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch (error) {
    if (isNewlineDelimitedJson(rawBody) || !claimsJson(rawBody, contentType)) {
      return {};
    }
    throw new Error(
      `dispatchOperation: response declared JSON but its body is not a JSON document: ${(error as Error).message}\n--- body ---\n${rawBody.slice(0, 500)}`
    );
  }
}

/**
 * Whether the response presents itself as a single JSON document — either by
 * declaring a JSON `content-type`, or by opening with an object/array token.
 */
function claimsJson(
  rawBody: string,
  contentType: string | number | readonly string[] | undefined
): boolean {
  const declared = Array.isArray(contentType)
    ? contentType.join(",")
    : String(contentType ?? "");
  if (declared.toLowerCase().includes("json")) {
    return true;
  }
  const opening = rawBody.trimStart().charAt(0);
  return opening === "{" || opening === "[";
}

/**
 * True when the body looks like an SSE stream: more than one non-empty line,
 * at least one of which is a JSON document. "At least one" rather than "all" so
 * a stream truncated mid-line still reads as a stream instead of masquerading
 * as a malformed single-document response.
 */
function isNewlineDelimitedJson(rawBody: string): boolean {
  const lines = rawBody.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return false;
  }
  return lines.some((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Creates a temp-dir factory that resolves symlinks (macOS `/var` →
 * `/private/var`) so paths line up with the canonicalized forms the security
 * layer compares against, and auto-cleans after each test.
 */
export function createGitOpTempDirs(prefix: string): {
  makeTempDir: () => string;
} {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  function makeTempDir(): string {
    const dir = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), prefix))
    );
    tempDirs.push(dir);
    return dir;
  }

  return { makeTempDir };
}

/**
 * Assert that a streamed SSE response actually reached its success path.
 *
 * A `done` event alone proves nothing. Every streaming consumer
 * (`terminal-chat`, `ticket-chat`, `run-viewer-chat`, `chat-providers`) catches
 * a spawn rejection, writes an `error` event and still calls `finish()`, which
 * emits `done` — so `events.some(e => e.type === "done")` is green whether the
 * child streamed its scripted lines or `FakeProcessManager` rejected on an
 * exhausted queue. Requiring the ABSENCE of `error` is what gives the assertion
 * the ability to fail.
 *
 * Throws rather than asserting: biome's `noMisplacedAssertion` reserves the
 * assertion helpers for test bodies, and a throw fails the test just as hard.
 */
export function assertStreamSucceeded(
  events: readonly Record<string, unknown>[]
): void {
  const errorEvents = events.filter((event) => event.type === "error");
  if (errorEvents.length > 0) {
    throw new Error(
      `stream emitted error event(s) instead of completing its success path: ${JSON.stringify(errorEvents)}`
    );
  }
  if (!events.some((event) => event.type === "done")) {
    throw new Error(
      `stream never emitted a done event; saw: ${JSON.stringify(events.map((event) => event.type))}`
    );
  }
}

/**
 * Pin `SYMPHONY_WORKTREE_PARENT_DIR` unset for the enclosing suite, restoring
 * whatever the host had once it finishes.
 *
 * `resolveWorktreeDir` prefers that variable over its default
 * `dirname(repoPath)` branch. A suite that builds fixtures at the default path
 * while an ambient value silently redirects the handler somewhere else either
 * fails for a reason that has nothing to do with the code under test, or —
 * worse — passes through a branch it never meant to exercise. AGENTS.md:
 * "Tests for precedence or ordered fallback behavior must explicitly clear
 * higher-priority inputs, environment variables, or mocks that are not under
 * test so inherited local or CI state cannot satisfy an earlier branch."
 *
 * Suites that deliberately drive the override branch must NOT call this.
 */
export function pinDefaultWorktreeParentDir(): void {
  const saved = process.env.SYMPHONY_WORKTREE_PARENT_DIR;

  beforeEach(() => {
    Reflect.deleteProperty(process.env, "SYMPHONY_WORKTREE_PARENT_DIR");
  });

  after(() => {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, "SYMPHONY_WORKTREE_PARENT_DIR");
    } else {
      process.env.SYMPHONY_WORKTREE_PARENT_DIR = saved;
    }
  });
}
