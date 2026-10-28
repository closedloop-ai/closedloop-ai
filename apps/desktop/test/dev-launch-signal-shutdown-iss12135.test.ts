/**
 * ISS-12135: the dev launcher's signal handler bounds how long it waits for
 * its servers to close. Unbounded, a close that never settled left the Desktop
 * browser bridge running through every SIGTERM `vibe down` sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLEANUP_TIMEOUT_MS,
  createSignalShutdown,
  handleElectronExit,
} from "../scripts/dev-launch-exit.mjs";

const NEVER_SETTLES = () => new Promise<void>(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSignalShutdown", () => {
  it("forwards the signal, then exits once the cleanup timeout passes though the servers never closed", async () => {
    const forward = vi.fn();
    const exit = vi.fn();
    const shutDown = createSignalShutdown({
      forward,
      cleanup: NEVER_SETTLES,
      exit,
    });

    const done = shutDown("SIGTERM");
    await vi.advanceTimersByTimeAsync(CLEANUP_TIMEOUT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(forward).toHaveBeenCalledWith("SIGTERM");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits as soon as the servers close", async () => {
    const exit = vi.fn();
    const cleanup = vi.fn(() => Promise.resolve());
    const shutDown = createSignalShutdown({
      forward: vi.fn(),
      cleanup,
      exit,
    });

    await shutDown("SIGINT");

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits at once on a second signal while the first is still closing", async () => {
    const forward = vi.fn();
    const exit = vi.fn();
    const shutDown = createSignalShutdown({
      forward,
      cleanup: NEVER_SETTLES,
      exit,
    });

    shutDown("SIGTERM").catch(() => undefined);
    await shutDown("SIGTERM");

    expect(exit).toHaveBeenCalledWith(0);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("exits when the cleanup throws", async () => {
    const exit = vi.fn();
    const shutDown = createSignalShutdown({
      forward: vi.fn(),
      cleanup: () => Promise.reject(new Error("server was not running")),
      exit,
    });

    await shutDown("SIGHUP");

    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("handleElectronExit", () => {
  it("exits with the child's status once the cleanup timeout passes though the servers never closed", async () => {
    const exit = vi.fn();

    const done = handleElectronExit(3, null, { cleanup: NEVER_SETTLES, exit });
    await vi.advanceTimersByTimeAsync(CLEANUP_TIMEOUT_MS);
    await done;

    expect(exit).toHaveBeenCalledWith(3);
  });
});
