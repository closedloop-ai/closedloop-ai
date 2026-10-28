/**
 * ISS-11285: the real spawn's handling of a tsc child that dies to a signal.
 * `node:child_process` is mocked so the child can report `close(null, signal)`
 * without killing a real compiler.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

const { runTypecheckPasses } = await import("../scripts/typecheck-runner.mjs");

const PROJECT = {
  name: "main",
  project: "tsconfig.main.json",
  tsBuildInfoFile: "node_modules/.cache/tsc-main.tsbuildinfo",
};

const FAILED_EXIT_ONE = /^\[typecheck\] main: FAILED \(exit 1\) in /;

function fakeChild(onSpawn: (child: EventEmitter) => void): EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => onSpawn(child));
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe("runTypecheckPasses through the default spawn", () => {
  it("fails a project whose tsc child was killed by a signal and names the signal", async () => {
    spawnMock.mockImplementation(() =>
      fakeChild((child) => child.emit("close", null, "SIGKILL"))
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runTypecheckPasses({
      projects: [PROJECT],
      concurrency: 1,
    });

    expect(code).toBe(1);
    const errorText = errors.mock.calls.map((call) => String(call[0]));
    expect(errorText).toContain("[typecheck] main terminated on SIGKILL");
    expect(errorText).toContain("[typecheck] 1 of 1 projects failed: main");
    expect(
      logs.mock.calls.some((call) => FAILED_EXIT_ONE.test(String(call[0])))
    ).toBe(true);
  });

  it("does not print a signal line for a child that exits with a code", async () => {
    spawnMock.mockImplementation(() =>
      fakeChild((child) => child.emit("close", 0, null))
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runTypecheckPasses({
      projects: [PROJECT],
      concurrency: 1,
    });

    expect(code).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });
});
