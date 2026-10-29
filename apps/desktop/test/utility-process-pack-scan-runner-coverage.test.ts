import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PackScanWorkerFailureError,
  PackScanWorkerResponseType,
  WORKER_INVALID_RESPONSE_MESSAGE_PREFIX,
} from "../src/main/packs/pack-scan-worker-protocol.js";
import type { PackScanComputeResult } from "../src/main/packs/pack-scanner.js";
import {
  createUtilityProcessPackScanRunner,
  type PackScanRunner,
} from "../src/main/packs/utility-process-pack-scan-runner.js";

const electronFork = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  default: { utilityProcess: { fork: electronFork } },
}));

const WORKER_PATH_SUFFIX = /pack-scan-worker\.js$/;
const INVALID_REQUEST = /invalid pack scan request/;
const RUN_GOT_DEFINITIONS = /replied "definitions" to a "run" request/;
const RUN_GOT_OMITTED = /replied "definitionsOmitted" to a "run" request/;
const EXITED_CODE_NULL = /exited with code null/;

type SentRequest = { type: string; requestId: string };

class FakeWorker extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly sent: SentRequest[] = [];
  killCount = 0;
  postError: unknown = null;
  postMessage(message: SentRequest): void {
    if (this.postError !== null) {
      throw this.postError;
    }
    this.sent.push(message);
  }
  kill(): void {
    this.killCount += 1;
  }
}

type Harness = {
  runner: PackScanRunner;
  children: FakeWorker[];
  logs: string[];
};

const runners: PackScanRunner[] = [];

afterEach(() => {
  for (const runner of runners) {
    runner.stop();
  }
  runners.length = 0;
  electronFork.mockReset();
});

function makeHarness(configure?: (child: FakeWorker) => void): Harness {
  const children: FakeWorker[] = [];
  const logs: string[] = [];
  const runner = createUtilityProcessPackScanRunner({
    log: (message) => logs.push(message),
    forkWorker: () => {
      const child = new FakeWorker();
      configure?.(child);
      children.push(child);
      return child;
    },
  });
  runners.push(runner);
  return { runner, children, logs };
}

function computeResult(): PackScanComputeResult {
  return {
    plan: { packs: [], skills: [], associations: [] },
    counts: {
      gstack: { installs: 0, skills: 0 },
      bmad: { installs: 0, skills: 0, projects: 0 },
      marketplaces: { installs: 0, skills: 0, marketplaces: 0 },
      catalogDetectors: {},
      gstackProjects: 0,
    },
    scopes: {
      gstack: true,
      bmad: true,
      marketplaces: true,
      gstackProjects: true,
      catalogDetectors: true,
    },
  };
}

function computedReply(requestId: string) {
  return {
    type: PackScanWorkerResponseType.Computed,
    requestId,
    result: computeResult(),
  };
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("createUtilityProcessPackScanRunner defaults", () => {
  it("forks through electron.utilityProcess when no forkWorker is injected", async () => {
    const child = new FakeWorker();
    electronFork.mockReturnValue(child);
    const runner = createUtilityProcessPackScanRunner();
    runners.push(runner);

    const promise = runner.computeScan(["/proj/a"]);

    expect(electronFork).toHaveBeenCalledTimes(1);
    const [modulePath, args, options] = electronFork.mock.calls[0] ?? [];
    expect(modulePath).toMatch(WORKER_PATH_SUFFIX);
    expect(args).toEqual([]);
    expect(options).toEqual({
      serviceName: "closedloop-pack-scanner",
      stdio: ["ignore", "ignore", "pipe"],
    });
    const requestId = child.sent[0]?.requestId ?? "";
    child.emit("message", computedReply(requestId));
    await expect(promise).resolves.toEqual(computeResult());
  });

  it("still rejects on an invalid response when no log sink is injected", async () => {
    const child = new FakeWorker();
    const runner = createUtilityProcessPackScanRunner({
      forkWorker: () => child,
    });
    runners.push(runner);

    const promise = runner.computeScan([]);
    child.emit("message", { type: PackScanWorkerResponseType.Computed });

    await expect(promise).rejects.toThrow(
      WORKER_INVALID_RESPONSE_MESSAGE_PREFIX
    );
  });
});

describe("dispatch", () => {
  it("rejects a request that fails the wire schema without forking a worker", async () => {
    const { runner, children } = makeHarness();
    const tooManyRoots = Array.from({ length: 10_001 }, (_, i) => `/p/${i}`);

    await expect(runner.computeScan(tooManyRoots)).rejects.toThrow(
      INVALID_REQUEST
    );
    expect(children).toHaveLength(0);
  });

  it("rejects with the fork error when spawning the worker throws an Error", async () => {
    const forkError = new Error("fork refused");
    const runner = createUtilityProcessPackScanRunner({
      forkWorker: () => {
        throw forkError;
      },
    });
    runners.push(runner);

    await expect(runner.computeScan([])).rejects.toBe(forkError);
  });

  it("wraps a non-Error fork throw in an Error", async () => {
    const thrown: unknown = "fork string failure";
    const runner = createUtilityProcessPackScanRunner({
      forkWorker: () => {
        throw thrown;
      },
    });
    runners.push(runner);

    await expect(runner.computeScan([])).rejects.toThrow("fork string failure");
  });

  it("rejects with the postMessage Error and keeps the child for the next request", async () => {
    const postError = new Error("channel closed");
    const { runner, children } = makeHarness((child) => {
      child.postError = postError;
    });

    await expect(runner.computeScan([])).rejects.toBe(postError);
    const child = children[0];
    expect(child?.killCount).toBe(0);

    // The failed send does not detach the child: the next request reuses it.
    if (child) {
      child.postError = null;
    }
    const second = runner.computeScan([]);
    expect(children).toHaveLength(1);
    child?.emit("message", computedReply(child.sent[0]?.requestId ?? ""));
    await expect(second).resolves.toEqual(computeResult());
  });

  it("wraps a non-Error postMessage throw in an Error", async () => {
    const { runner } = makeHarness((child) => {
      child.postError = 42;
    });

    await expect(runner.computeScan([])).rejects.toThrow("42");
  });

  it("reuses one child across sequential requests", async () => {
    const { runner, children } = makeHarness();

    const first = runner.computeScan([]);
    children[0]?.emit(
      "message",
      computedReply(children[0]?.sent[0]?.requestId ?? "")
    );
    await first;
    const second = runner.computeDefinitions({});
    children[0]?.emit("message", {
      type: PackScanWorkerResponseType.Definitions,
      requestId: children[0]?.sent[1]?.requestId ?? "",
      definitions: [],
    });

    await expect(second).resolves.toEqual({ omitted: false, definitions: [] });
    expect(children).toHaveLength(1);
    expect(children[0]?.sent.map((request) => request.requestId)).toEqual([
      "pack-scan-1",
      "pack-scan-2",
    ]);
  });
});

describe("worker stderr", () => {
  it("logs a non-empty stderr chunk and drops a whitespace-only chunk", () => {
    const { runner, children, logs } = makeHarness();
    runner.computeScan([]).catch(() => undefined);

    children[0]?.stderr.emit("data", Buffer.from("   \n"));
    children[0]?.stderr.emit("data", Buffer.from("boom\n"));

    expect(logs).toEqual(["pack-scan worker stderr: boom"]);
  });
});

describe("response handling", () => {
  it("rejects with the bare prefix when an invalid response carries no requestId", async () => {
    const { runner, children, logs } = makeHarness();
    const promise = runner.computeScan([]);

    children[0]?.emit("message", { type: "nonsense" });

    await expect(promise).rejects.toThrow(
      new Error(WORKER_INVALID_RESPONSE_MESSAGE_PREFIX)
    );
    expect(children[0]?.killCount).toBe(1);
    expect(
      logs[0]?.startsWith(`${WORKER_INVALID_RESPONSE_MESSAGE_PREFIX}: `)
    ).toBe(true);
  });

  it("ignores a reply whose requestId has no pending entry", async () => {
    const { runner, children } = makeHarness();
    const promise = runner.computeScan([]);
    const child = children[0];

    child?.emit("message", computedReply("pack-scan-999"));
    child?.emit("message", computedReply(child.sent[0]?.requestId ?? ""));

    await expect(promise).resolves.toEqual(computeResult());
    expect(child?.killCount).toBe(0);
  });

  it("rejects a definitions reply to a run request", async () => {
    const { runner, children } = makeHarness();
    const promise = runner.computeScan([]);

    children[0]?.emit("message", {
      type: PackScanWorkerResponseType.Definitions,
      requestId: children[0]?.sent[0]?.requestId ?? "",
      definitions: [],
    });

    await expect(promise).rejects.toThrow(RUN_GOT_DEFINITIONS);
  });

  it("rejects a definitionsOmitted reply to a run request", async () => {
    const { runner, children } = makeHarness();
    const promise = runner.computeScan([]);

    children[0]?.emit("message", {
      type: PackScanWorkerResponseType.DefinitionsOmitted,
      requestId: children[0]?.sent[0]?.requestId ?? "",
      reason: "too big",
    });

    await expect(promise).rejects.toThrow(RUN_GOT_OMITTED);
  });

  it("logs a non-fatal failure's diagnostic and keeps the child alive", async () => {
    const { runner, children, logs } = makeHarness();
    const promise = runner.computeScan([]);

    children[0]?.emit("message", {
      type: PackScanWorkerResponseType.Failed,
      requestId: children[0]?.sent[0]?.requestId ?? "",
      message: "scan failed",
      diagnostic: "stack here",
    });

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PackScanWorkerFailureError);
    expect(error).toMatchObject({
      message: "scan failed",
      kind: "worker_failure",
      diagnostic: "stack here",
    });
    expect(logs).toEqual(["scan failed: stack here"]);
    expect(children[0]?.killCount).toBe(0);
  });

  it("a non-fatal failure without a diagnostic logs nothing", async () => {
    const { runner, children, logs } = makeHarness();
    const promise = runner.computeScan([]);

    children[0]?.emit("message", {
      type: PackScanWorkerResponseType.Failed,
      requestId: children[0]?.sent[0]?.requestId ?? "",
      message: "scan failed",
    });

    await expect(promise).rejects.toThrow("scan failed");
    expect(logs).toEqual([]);
  });

  it("a fatal failure rejects every pending request on that child and kills it", async () => {
    const { runner, children, logs } = makeHarness();
    const scan = runner.computeScan([]);
    const definitions = runner.computeDefinitions({});

    children[0]?.emit("message", {
      type: PackScanWorkerResponseType.Failed,
      requestId: children[0]?.sent[0]?.requestId ?? "",
      message: "worker corrupted",
      fatal: true,
      diagnostic: "heap",
    });

    await expect(scan).rejects.toThrow("worker corrupted");
    await expect(definitions).rejects.toThrow("worker corrupted");
    expect(children[0]?.killCount).toBe(1);
    expect(logs).toEqual(["worker corrupted: heap"]);

    // The killed child is detached: the next request forks a fresh one.
    runner.computeScan([]).catch(() => undefined);
    expect(children).toHaveLength(2);
  });

  it("a fatal failure without a diagnostic logs nothing", async () => {
    const { runner, children, logs } = makeHarness();
    const promise = runner.computeScan([]);

    children[0]?.emit("message", {
      type: PackScanWorkerResponseType.Failed,
      requestId: "pack-scan-unrelated",
      message: "worker corrupted",
      fatal: true,
    });

    await expect(promise).rejects.toThrow("worker corrupted");
    expect(logs).toEqual([]);
  });
});

describe("child lifecycle", () => {
  it("a child error event rejects its pending request, logs, and kills it", async () => {
    const { runner, children, logs } = makeHarness();
    const promise = runner.computeScan([]);

    children[0]?.emit("error", "FatalError", "worker.js:10", "report");

    await expect(promise).rejects.toThrow(
      "pack scan worker error: FatalError at worker.js:10"
    );
    expect(logs).toEqual([
      "pack scan worker error: FatalError at worker.js:10",
    ]);
    expect(children[0]?.killCount).toBe(1);
  });

  it("ignores error and exit events from a child that is no longer current", async () => {
    const { runner, children, logs } = makeHarness();
    const first = runner.computeScan([]);
    children[0]?.emit("error", "FatalError", "a", "r");
    await expect(first).rejects.toThrow("FatalError at a");

    const second = runner.computeScan([]);
    const stale = children[0];
    stale?.emit("error", "FatalError", "b", "r");
    stale?.emit("exit", 1);
    stale?.emit("message", { type: "garbage" });
    await nextMacrotask();

    expect(logs).toEqual(["pack scan worker error: FatalError at a"]);
    expect(stale?.killCount).toBe(1);
    children[1]?.emit(
      "message",
      computedReply(children[1]?.sent[0]?.requestId ?? "")
    );
    await expect(second).resolves.toEqual(computeResult());
  });

  it("delivers a reply that races the exit of an exiting child", async () => {
    const { runner, children } = makeHarness();
    const promise = runner.computeScan([]);
    const child = children[0];

    child?.emit("exit", null);
    child?.emit("message", computedReply(child.sent[0]?.requestId ?? ""));

    await expect(promise).resolves.toEqual(computeResult());
  });

  it("an exit rejects only the exiting child's requests, not a replacement's", async () => {
    const { runner, children } = makeHarness();
    const oldRequest = runner.computeScan([]);
    children[0]?.emit("exit", null);
    const newRequest = runner.computeScan([]);

    await expect(oldRequest).rejects.toThrow(EXITED_CODE_NULL);
    expect(children).toHaveLength(2);
    children[1]?.emit(
      "message",
      computedReply(children[1]?.sent[0]?.requestId ?? "")
    );
    await expect(newRequest).resolves.toEqual(computeResult());
  });

  it("an invalid reply from an exiting child kills that child without detaching the replacement", async () => {
    const { runner, children } = makeHarness();
    const oldRequest = runner.computeScan([]);
    children[0]?.emit("exit", 1);
    const newRequest = runner.computeScan([]);

    children[0]?.emit("message", { type: "garbage" });
    await expect(oldRequest).rejects.toThrow(
      WORKER_INVALID_RESPONSE_MESSAGE_PREFIX
    );
    expect(children[0]?.killCount).toBe(1);
    expect(children[1]?.killCount).toBe(0);

    children[1]?.emit(
      "message",
      computedReply(children[1]?.sent[0]?.requestId ?? "")
    );
    await expect(newRequest).resolves.toEqual(computeResult());
    expect(children).toHaveLength(2);
  });

  it("an exiting child's reply cannot settle a replacement child's request", async () => {
    const { runner, children } = makeHarness();
    runner.computeScan([]).catch(() => undefined);
    children[0]?.emit("exit", 0);
    const newRequest = runner.computeScan([]);
    const newRequestId = children[1]?.sent[0]?.requestId ?? "";
    const staleResult = computeResult();
    staleResult.counts.gstackProjects = 99;

    children[0]?.emit("message", {
      type: PackScanWorkerResponseType.Computed,
      requestId: newRequestId,
      result: staleResult,
    });
    children[1]?.emit("message", computedReply(newRequestId));

    await expect(newRequest).resolves.toEqual(computeResult());
  });

  it("stop rejects in-flight requests and kills the current child", async () => {
    const { runner, children } = makeHarness();
    const promise = runner.computeDefinitions({});

    runner.stop();

    await expect(promise).rejects.toThrow("pack scan worker stopped");
    expect(children[0]?.killCount).toBe(1);
  });
});
