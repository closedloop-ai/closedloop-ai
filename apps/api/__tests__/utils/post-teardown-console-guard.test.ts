import { describe, expect, it, type Mock, vi } from "vitest";
import {
  guardPostTeardownConsole,
  isPostTeardownConsoleGuardInstalled,
  type PostTeardownWrite,
  postTeardownWriteReport,
  writePostTeardownReport,
} from "./post-teardown-console-guard";

/**
 * ISS-10749. The defect the guard exists to stop is a console write leaving the
 * worker on Vitest's RPC channel after the file is done, so the case that
 * matters is the DIVERT branch: a green run with the guard removed is the
 * regression, because the write goes back onto that channel.
 *
 * Spelled out rather than derived from the module's own list, so dropping a
 * method from the guard fails here instead of quietly narrowing both sides.
 */
const INTERCEPTED_METHODS = [
  "assert",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "trace",
  "warn",
] as const;

type ConsoleWrite = (...args: unknown[]) => void;

type FakeConsole = Record<
  (typeof INTERCEPTED_METHODS)[number],
  Mock<ConsoleWrite>
>;

function fakeConsole(): FakeConsole {
  return Object.fromEntries(
    INTERCEPTED_METHODS.map((method) => [method, vi.fn<ConsoleWrite>()])
  ) as FakeConsole;
}

describe("guardPostTeardownConsole", () => {
  it("passes a write through to the real console while the file is running", () => {
    const target = fakeConsole();
    // Captured before guarding: the guard REPLACES the property, so reading it
    // back afterwards reads the wrapper and not the spy underneath it.
    const warn = target.warn;
    const diverted: PostTeardownWrite[] = [];
    guardPostTeardownConsole({
      target,
      hasFinished: () => false,
      divert: (write) => diverted.push(write),
    });

    target.warn("pool error", { code: "ECONNREFUSED" });

    expect(warn).toHaveBeenCalledWith("pool error", { code: "ECONNREFUSED" });
    expect(diverted).toEqual([]);
  });

  it("diverts a write that arrives after the file finished, formatted", () => {
    const target = fakeConsole();
    const error = target.error;
    const diverted: PostTeardownWrite[] = [];
    let finished = false;
    guardPostTeardownConsole({
      target,
      hasFinished: () => finished,
      divert: (write) => diverted.push(write),
    });

    finished = true;
    target.error("Failed to record audit events", { artifactId: "doc-1" });

    // The real console is never reached, which is what keeps the write off the
    // `onUserConsoleLog` RPC the worker is closing.
    expect(error).not.toHaveBeenCalled();
    expect(diverted.map((write) => write.method)).toEqual(["error"]);
    expect(diverted[0]?.text).toBe(
      "Failed to record audit events { artifactId: 'doc-1' }"
    );
  });

  it("records the seam the late write came from", () => {
    const target = fakeConsole();
    const diverted: PostTeardownWrite[] = [];
    guardPostTeardownConsole({
      target,
      hasFinished: () => true,
      divert: (write) => diverted.push(write),
    });

    function emitAuditEventsStandIn() {
      target.error("Failed to record audit events");
    }
    emitAuditEventsStandIn();

    expect(diverted[0]?.stack).toContain("emitAuditEventsStandIn");
  });

  it("guards every console method Vitest intercepts", () => {
    const target = fakeConsole();
    const spies = Object.values({ ...target });
    const diverted: PostTeardownWrite[] = [];
    guardPostTeardownConsole({
      target,
      hasFinished: () => true,
      divert: (write) => diverted.push(write),
    });

    for (const method of INTERCEPTED_METHODS) {
      (target as Record<string, (...args: unknown[]) => void>)[method]("late");
    }

    expect(diverted.map((write) => write.method)).toEqual([
      ...INTERCEPTED_METHODS,
    ]);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("postTeardownWriteReport", () => {
  const write: PostTeardownWrite = { method: "warn", text: "late write" };

  it("names the originating file and the write", () => {
    const lines = postTeardownWriteReport("apps/api/x.test.ts", write);

    expect(lines.join("\n")).toContain("apps/api/x.test.ts");
    expect(lines.join("\n")).toContain("console.warn: late write");
    expect(lines.join("\n")).not.toContain("written from:");
  });

  it("points at the seam when the write carries a stack", () => {
    const lines = postTeardownWriteReport("apps/api/x.test.ts", {
      ...write,
      stack: "    at emitAuditEvents (apps/api/app/audit/emit.ts:12:3)",
    });

    expect(lines.join("\n")).toContain(
      "at emitAuditEvents (apps/api/app/audit/emit.ts:12:3)"
    );
  });

  it("annotates on a runner and stays quiet off one", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const annotated = postTeardownWriteReport("apps/api/x.test.ts", write);
    vi.stubEnv("GITHUB_ACTIONS", "");
    const plain = postTeardownWriteReport("apps/api/x.test.ts", write);
    vi.unstubAllEnvs();

    expect(annotated.some((line) => line.startsWith("::error file="))).toBe(
      true
    );
    expect(plain.some((line) => line.startsWith("::error file="))).toBe(false);
  });

  // GitHub resolves an annotation path from the repo root, so an absolute
  // worker path would annotate a file GitHub cannot find.
  it("annotates a path relative to the workspace root", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_WORKSPACE", "/home/runner/work/repo/repo");
    const lines = postTeardownWriteReport(
      "/home/runner/work/repo/repo/apps/api/x.test.ts",
      write
    );
    vi.unstubAllEnvs();

    expect(lines).toContain("  originating test file: apps/api/x.test.ts");
    expect(
      lines.some((line) => line.startsWith("::error file=apps/api/x.test.ts,"))
    ).toBe(true);
  });
});

describe("writePostTeardownReport", () => {
  it("prints the whole report in one write, so a terminating worker cannot drop half of it", () => {
    const chunks: string[] = [];

    writePostTeardownReport(
      { write: (chunk) => chunks.push(chunk) },
      "apps/api/x.test.ts",
      { method: "warn", text: "late write" }
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("apps/api/x.test.ts");
    expect(chunks[0]).toContain("console.warn: late write");
  });
});

describe("production wiring", () => {
  // This file runs under `__tests__/setup.ts`, so a guard installed on this
  // worker is proof the setup file CALLED the installer. Deleting that call
  // reddens this test; an assertion on the import alone would not notice.
  it("is installed by the apps/api vitest setup file", () => {
    expect(isPostTeardownConsoleGuardInstalled()).toBe(true);
  });
});
