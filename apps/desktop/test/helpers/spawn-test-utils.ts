/**
 * Shared helpers for spawn ENOENT hardening tests.
 *
 * Used by:
 *   - spawn-hardening.test.ts
 *   - codex-spawn-enoent.test.ts
 */

import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// MockChildProcess
// ---------------------------------------------------------------------------

/**
 * Minimal mock ChildProcess with stdout, stderr, stdin sub-emitters and
 * a pid field.  Matches the interface that spawn() returns.
 */
export type MockChildProcess = EventEmitter & {
  stdout: EventEmitter & { setEncoding: (enc: string) => void };
  stderr: EventEmitter & { setEncoding: (enc: string) => void };
  stdin: EventEmitter & { write: (data: string) => void; end: () => void };
  pid: number | undefined;
  kill: () => void;
  unref: () => void;
};

export function buildMockChildProcess(pid?: number): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;

  const stdout = new EventEmitter() as MockChildProcess["stdout"];
  stdout.setEncoding = () => {};
  child.stdout = stdout;

  const stderr = new EventEmitter() as MockChildProcess["stderr"];
  stderr.setEncoding = () => {};
  child.stderr = stderr;

  const stdin = new EventEmitter() as MockChildProcess["stdin"];
  stdin.write = () => {};
  stdin.end = () => {};
  child.stdin = stdin;

  child.pid = pid;
  child.kill = () => {};
  child.unref = () => {};
  return child;
}

// ---------------------------------------------------------------------------
// MockResponse
// ---------------------------------------------------------------------------

export type MockResponse = {
  written: string[];
  ended: boolean;
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  flushHeaders: () => void;
  socket: { setNoDelay: (flag: boolean) => void } | null;
  write: (chunk: string) => boolean;
  end: () => void;
};

export function buildMockResponse(): MockResponse {
  return {
    written: [],
    ended: false,
    statusCode: 200,
    setHeader: () => {},
    flushHeaders: () => {},
    socket: { setNoDelay: () => {} },
    write(chunk: string): boolean {
      this.written.push(chunk);
      return true;
    },
    end(): void {
      this.ended = true;
    },
  };
}

// ---------------------------------------------------------------------------
// parseWrittenEvents
// ---------------------------------------------------------------------------

/** Parse all SSE JSON lines written to a MockResponse. */
export function parseWrittenEvents(
  response: MockResponse
): Record<string, unknown>[] {
  return response.written
    .join("")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// makeEnoentError
// ---------------------------------------------------------------------------

/** Build a minimal ENOENT-style spawn error. */
export function makeEnoentError(binary = "run-loop.sh"): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${binary} ENOENT`), {
    code: "ENOENT",
    syscall: "spawn",
  });
}
