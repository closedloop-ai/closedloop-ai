import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentDashboardDbHostLifecycle } from "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js";
import { bootstrapAgentDashboardRuntime } from "../src/main/dashboard/agent-dashboard-runtime-bootstrap.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
  type DbHostResponse,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import type { DbStoreClientDeps } from "../src/main/database/db-host/db-store-client.js";
import { STORE_OPEN_DEADLINE_MS } from "../src/main/database/db-host/db-store-deadlines.js";
import {
  type DbStoreRequest,
  DbStoreRequestKind,
  DbStoreResponseKind,
} from "../src/main/database/db-host/db-store-protocol.js";
import { bootstrapDeps } from "./agent-dashboard-bootstrap-fixture.js";
import { deferred } from "./deferred.js";

const seams = vi.hoisted(() => ({
  createWorker: vi.fn(),
  createRuntime: vi.fn(),
}));
vi.mock("../src/main/database/db-host/db-store-client.js", async (original) => {
  const actual =
    await original<
      typeof import("../src/main/database/db-host/db-store-client.js")
    >();
  return {
    ...actual,
    createDbStoreClient: (deps: DbStoreClientDeps) =>
      actual.createDbStoreClient({ ...deps, createWorker: seams.createWorker }),
  };
});
vi.mock(
  "../src/main/dashboard/agent-dashboard-design-system-runtime.js",
  () => ({ createAgentDashboardDesignSystemRuntime: seams.createRuntime })
);
vi.mock(
  "../src/main/database/database-integrity/zombie-db-holder-os.js",
  () => ({ buildZombieDbHolderOsDeps: () => null })
);
vi.mock(
  "../src/main/database/db-host/db-host-memory-watchdog.js",
  async (original) => ({
    ...(await original<
      typeof import("../src/main/database/db-host/db-host-memory-watchdog.js")
    >()),
    installProcessCrashLogging: vi.fn(),
    startHeapWatchdog: () => ({ stop: vi.fn() }),
  })
);
vi.mock("../src/main/logging/durable-log-sink.js", () => ({
  routeDurableLogsToSink: vi.fn(),
  writeRelayedDurableLog: vi.fn(),
  writeGatewayLogEntry: vi.fn(),
}));
vi.mock("../src/main/telemetry/telemetry-relay-sink.js", () => ({
  setTelemetryRelaySink: vi.fn(),
  getTelemetryRelaySink: () => null,
}));
vi.mock("electron", () => ({
  default: { utilityProcess: {} },
  app: { getPath: () => "/tmp/iss10210-store-open" },
  Notification: class {
    show() {}
  },
}));

const originalParentPort = Object.getOwnPropertyDescriptor(
  process,
  "parentPort"
);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  seams.createRuntime.mockReset();
  seams.createWorker.mockReset();
  if (originalParentPort) {
    Object.defineProperty(process, "parentPort", originalParentPort);
  } else {
    Reflect.deleteProperty(process, "parentPort");
  }
});

async function startBoot() {
  vi.useFakeTimers();
  const opened = deferred<void>();
  const exitRequested = deferred<number>();
  const firstChild = new EventEmitter();
  const storeThread = Object.assign(new EventEmitter(), {
    postMessage: (request: DbStoreRequest) => {
      if (request.kind === DbStoreRequestKind.Open) {
        opened.resolve();
      }
    },
    terminate: () => Promise.resolve(0),
  });
  seams.createWorker.mockReturnValue(storeThread);
  const replies: DbHostResponse[] = [];
  const port = Object.assign(new EventEmitter(), {
    postMessage: (response: DbHostResponse) => {
      replies.push(response);
      firstChild.emit("message", response);
    },
  });
  Object.defineProperty(process, "parentPort", {
    configurable: true,
    value: port,
  });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    exitRequested.resolve(Number(code));
    return undefined as never;
  });
  // Each import represents a fresh utility process, with its own dispatcher state.
  vi.resetModules();
  await import("../src/main/database/db-host/db-host-worker.js");
  let forks = 0;
  let released = false;
  const releaseAtFork: boolean[] = [];
  const openedRuntime = { opened: true };
  const lifecycles: ReturnType<typeof createAgentDashboardDbHostLifecycle>[] =
    [];
  seams.createRuntime.mockImplementation(
    async (options: AgentDashboardDesignSystemRuntimeOptions) => {
      const lifecycle = createAgentDashboardDbHostLifecycle({
        options,
        log: vi.fn(),
        getPackScanCoordinator: () => null,
        getCatalogCoordinator: () => null,
        fork: () => {
          forks++;
          const first = forks === 1;
          releaseAtFork.push(released);
          const child = first ? firstChild : new EventEmitter();
          return Object.assign(child, {
            postMessage: (request: DbHostRequest) => {
              if (first) {
                port.emit("message", { data: request });
              } else if (request.kind === DbHostRequestKind.Init) {
                queueMicrotask(() =>
                  child.emit("message", {
                    kind: DbHostResponseKind.Ready,
                    id: request.id,
                  })
                );
              }
            },
            kill: () => child.emit("exit", 0),
          });
        },
      });
      lifecycles.push(lifecycle);
      await lifecycle.ready;
      return openedRuntime;
    }
  );
  const waits: number[] = [];
  const failed = vi.fn();
  const result = bootstrapAgentDashboardRuntime(
    bootstrapDeps({
      setAgentMonitorFailed: failed,
      sleepBeforeStoreOpenRetry: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    })
  );
  await opened.promise;
  return {
    result,
    replies,
    storeThread,
    waits,
    failed,
    openedRuntime,
    releaseAtFork,
    exitRequested: exitRequested.promise,
    forks: () => forks,
    releaseAndExit: (code: number) => {
      released = true;
      firstChild.emit("exit", code);
    },
    dispose: () => {
      for (const lifecycle of lifecycles) {
        lifecycle.beginClosing();
      }
    },
  };
}

test("ISS-10210: timeout waits for DB-holder exit and retries without a Ready error", async () => {
  const boot = await startBoot();
  try {
    await vi.advanceTimersByTimeAsync(STORE_OPEN_DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(1);
    const code = await boot.exitRequested;
    expect(code).toBe(124);
    expect(
      boot.replies.filter((reply) => reply.kind === DbHostResponseKind.Ready)
    ).toEqual([]);
    expect(
      boot.waits,
      "the retry cannot start while the old process holds SQLite"
    ).toEqual([]);
    expect(boot.forks()).toBe(1);
    boot.releaseAndExit(code);
    expect(await boot.result).toEqual({
      ok: true,
      runtime: boot.openedRuntime,
    });
    expect(boot.waits).toEqual([30_000]);
    expect(boot.forks()).toBe(2);
    expect(boot.releaseAtFork).toEqual([false, true]);
    expect(boot.failed).not.toHaveBeenCalled();
  } finally {
    boot.dispose();
  }
});

test("ISS-10210: an unrelated store death remains a terminal boot failure", async () => {
  const boot = await startBoot();
  try {
    boot.storeThread.emit("error", new Error("native store failure"));
    await vi.advanceTimersByTimeAsync(1);
    const code = await boot.exitRequested;
    expect(code).toBe(1);
    boot.releaseAndExit(code);
    expect(await boot.result).toEqual({ ok: false });
    expect(boot.waits).toEqual([]);
    expect(boot.forks()).toBe(1);
    expect(boot.failed).toHaveBeenCalledOnce();
  } finally {
    boot.dispose();
  }
});

test("ISS-10210: deterministic refusals still answer Ready without exiting", async () => {
  const boot = await startBoot();
  try {
    boot.storeThread.emit("message", {
      kind: DbStoreResponseKind.Opened,
      error: { message: "migration checksum mismatch" },
    });
    expect(await boot.result).toEqual({ ok: false });
    expect(boot.replies).toContainEqual(
      expect.objectContaining({
        kind: DbHostResponseKind.Ready,
        error: expect.objectContaining({
          message: "migration checksum mismatch",
        }),
      })
    );
    expect(process.exit).not.toHaveBeenCalled();
    expect(boot.waits).toEqual([]);
    expect(boot.failed).toHaveBeenCalledOnce();
  } finally {
    boot.dispose();
  }
});
