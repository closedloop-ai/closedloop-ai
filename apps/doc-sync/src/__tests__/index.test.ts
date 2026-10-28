import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOC_SYNC_UNCAUGHT_EXCEPTION_EVENT } from "../lifecycle/process-faults";

const mocks = vi.hoisted(() => ({
  loadDocSyncEnvOrExit: vi.fn(),
  createPool: vi.fn(),
  createProbePool: vi.fn(),
  runMigrationsOrExit: vi.fn(),
  pgDocumentStorage: vi.fn(),
  createDocSyncServer: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: mocks.info, error: mocks.error },
}));

vi.mock("../env", () => ({ loadDocSyncEnvOrExit: mocks.loadDocSyncEnvOrExit }));
vi.mock("../storage/pool", () => ({
  createPool: mocks.createPool,
  createProbePool: mocks.createProbePool,
}));
vi.mock("../storage/migrate", () => ({
  MIGRATIONS_DIR: "/migrations",
  runMigrationsOrExit: mocks.runMigrationsOrExit,
}));
vi.mock("../storage/document-storage", () => ({
  pgDocumentStorage: mocks.pgDocumentStorage,
}));
vi.mock("../server", () => ({
  HTTP_SERVER_ERROR_EVENT: "doc_sync.http_server_error",
  createDocSyncServer: mocks.createDocSyncServer,
}));

const ENV = { port: 3050 };
const POOL = { kind: "pool" };
const PROBE_POOL = { kind: "probe-pool" };
const STORAGE = { kind: "storage" };

type Handler = (...args: unknown[]) => void;

let signalHandlers: Map<string, Handler>;
let exit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  signalHandlers = new Map();
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    handler: Handler
  ) => {
    signalHandlers.set(event, handler);
    return process;
  }) as typeof process.on);
  exit = vi.fn();
  vi.spyOn(process, "exit").mockImplementation(exit as never);
  mocks.createPool.mockReturnValue(POOL);
  mocks.createProbePool.mockReturnValue(PROBE_POOL);
  mocks.pgDocumentStorage.mockReturnValue(STORAGE);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});

/** A server double whose `listen` settles as `listen` says. */
function serverDouble(listen: () => Promise<void> = () => Promise.resolve()) {
  const httpHandlers = new Map<string, Handler>();
  let finishShutdown: () => void = () => undefined;
  const shutdownDone = new Promise<void>((resolve) => {
    finishShutdown = resolve;
  });
  const shutdown = vi.fn(() => shutdownDone);
  const server = {
    httpServer: {
      on: vi.fn((event: string, handler: Handler) => {
        httpHandlers.set(event, handler);
      }),
    },
    listen: vi.fn(listen),
    address: { port: ENV.port },
  };
  mocks.createDocSyncServer.mockReturnValue({ server, shutdown });
  return { server, shutdown, httpHandlers, finishShutdown };
}

async function boot(): Promise<void> {
  await import("../index");
  await vi.waitFor(() => undefined);
}

describe("doc-sync entrypoint", () => {
  it("opens no pool and starts no server when the env does not load", async () => {
    mocks.loadDocSyncEnvOrExit.mockResolvedValue(null);

    await boot();

    expect(mocks.loadDocSyncEnvOrExit).toHaveBeenCalledWith(process.env);
    expect(mocks.createPool).not.toHaveBeenCalled();
    expect(mocks.createProbePool).not.toHaveBeenCalled();
    expect(mocks.runMigrationsOrExit).not.toHaveBeenCalled();
    expect(mocks.createDocSyncServer).not.toHaveBeenCalled();
    expect(signalHandlers.size).toBe(0);
  });

  it("starts no server when the migrations fail", async () => {
    mocks.loadDocSyncEnvOrExit.mockResolvedValue({ ...ENV, pg: { db: 1 } });
    mocks.runMigrationsOrExit.mockResolvedValue(false);

    await boot();

    expect(mocks.createPool).toHaveBeenCalledWith({ db: 1 });
    expect(mocks.runMigrationsOrExit).toHaveBeenCalledWith(POOL, "/migrations");
    expect(mocks.createProbePool).not.toHaveBeenCalled();
    expect(mocks.createDocSyncServer).not.toHaveBeenCalled();
    expect(signalHandlers.size).toBe(0);
  });

  it("listens on pg storage, pinging through its own probe pool, once migrated, and SIGTERM and SIGINT exit 0 after shutdown", async () => {
    const env = { ...ENV, pg: { db: 1 } };
    mocks.loadDocSyncEnvOrExit.mockResolvedValue(env);
    mocks.runMigrationsOrExit.mockResolvedValue(true);
    const { server, shutdown, finishShutdown } = serverDouble();

    await boot();

    expect(mocks.createProbePool).toHaveBeenCalledWith(env.pg);
    expect(mocks.pgDocumentStorage).toHaveBeenCalledWith(POOL, PROBE_POOL);
    expect(mocks.createDocSyncServer).toHaveBeenCalledWith(env, STORAGE);
    expect(server.listen).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(mocks.info).toHaveBeenCalledWith("Doc sync service listening", {
        event: "doc_sync.listening",
        port: ENV.port,
      })
    );
    expect(exit).not.toHaveBeenCalled();

    signalHandlers.get("SIGTERM")?.();
    signalHandlers.get("SIGINT")?.();

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    finishShutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(2));
    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(exit.mock.calls).toEqual([[0], [0]]);
  });

  it("logs an HTTP server error and exits 1 after shutdown", async () => {
    mocks.loadDocSyncEnvOrExit.mockResolvedValue({ ...ENV, pg: {} });
    mocks.runMigrationsOrExit.mockResolvedValue(true);
    const { shutdown, httpHandlers, finishShutdown } = serverDouble();
    const failure = new Error("EADDRINUSE");

    await boot();
    httpHandlers.get("error")?.(failure);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    finishShutdown();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith("Doc sync HTTP server error", {
      event: "doc_sync.http_server_error",
      error: failure,
    });
  });

  it("installs the fault handlers: an uncaught exception exits 1 after shutdown, a rejection does not", async () => {
    mocks.loadDocSyncEnvOrExit.mockResolvedValue({ ...ENV, pg: {} });
    mocks.runMigrationsOrExit.mockResolvedValue(true);
    const { shutdown, finishShutdown } = serverDouble();

    await boot();
    signalHandlers.get("unhandledRejection")?.(new Error("rejected"));
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();

    signalHandlers.get("uncaughtException")?.(new Error("thrown"));
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    finishShutdown();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.error).toHaveBeenCalledWith(
      "Doc sync uncaught exception",
      expect.objectContaining({ event: DOC_SYNC_UNCAUGHT_EXCEPTION_EVENT })
    );
  });

  it("treats a failed listen as a server error", async () => {
    mocks.loadDocSyncEnvOrExit.mockResolvedValue({ ...ENV, pg: {} });
    mocks.runMigrationsOrExit.mockResolvedValue(true);
    const failure = new Error("listen failed");
    const { finishShutdown } = serverDouble(() => Promise.reject(failure));
    finishShutdown();

    await boot();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.error).toHaveBeenCalledWith("Doc sync HTTP server error", {
      event: "doc_sync.http_server_error",
      error: failure,
    });
    expect(mocks.info).not.toHaveBeenCalledWith(
      "Doc sync service listening",
      expect.anything()
    );
  });
});
