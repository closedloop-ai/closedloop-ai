/**
 * @file db-store-worker.ts
 * @description ISS-8246 M1 — the store thread's entry point, and deliberately
 * almost nothing else.
 *
 * ## This file is a BOOTSTRAP, and that is a correctness property
 *
 * It statically imports two things: `node:worker_threads`, and
 * `./db-store-protocol.js`, which is itself runtime-import-free (every import in
 * it is `import type`, which erases at build). Everything else — the store, its
 * Prisma client, the migration runner, the whole `apps/desktop` module graph
 * behind them — is reached through a dynamic `import()` INSIDE the try/catch
 * below.
 *
 * The reason is a crash loop. A static import that throws runs BEFORE any
 * top-frame catch exists, so it surfaces as a `Worker` `error` event rather than
 * as a message. On the dispatcher that becomes an `uncaughtException`, which
 * `installProcessCrashLogging` turns into `process.exit(1)`, which
 * `DbHostClient` reads as a crash and restarts. A migration refusal is
 * DETERMINISTIC — the runner refuses the same checksum drift every time — so
 * that restart refuses again, and again. The current design avoids this by
 * answering `Ready` WITH AN ERROR and staying alive, which lets boot surface an
 * Agent Monitor failure and register disabled DB IPC. Keeping the store's module
 * graph behind the catch is what preserves that here.
 *
 * So: do not add a static import to this file. The old `db-host-worker.ts` shape
 * — heavy top-level imports plus module-body setup — is exactly what must not be
 * copied across.
 *
 * ## Nothing here calls `process.exit()`
 *
 * Probe 8 measured it: inside a worker thread `process.exit()` ends the THREAD
 * and the utilityProcess survives to observe the code. Exiting is the
 * dispatcher's job (PLN-1837 §1.3) — it watches `worker.on("exit")` and exits
 * non-zero itself, which is what routes a store-thread death back into the
 * `DbHostClient.handleExit` path that rejects pending invokes and re-forks.
 */

import { parentPort } from "node:worker_threads";
import type { DbHostError } from "./db-host-protocol.js";
import type * as ResultCodec from "./db-host-result-codec.js";
import type { DbStoreHost } from "./db-store-host.js";
import {
  type DbStoreRequest,
  DbStoreRequestKind,
  type DbStoreResponse,
  DbStoreResponseKind,
  isDbStoreRequest,
} from "./db-store-protocol.js";
import type * as StoreReadCancellation from "./store-read-cancellation.js";

let host: DbStoreHost | null = null;

/**
 * ISS-9802 — the cancellation registry, reached through a DYNAMIC import.
 *
 * This file's header forbids a static import, and that rule holds even for a
 * leaf module: the two static imports it does have are the whole reason a
 * migration refusal answers `Opened` with an error instead of crash-looping.
 * The registry is a plain `node:async_hooks` scope with no I/O, so this resolves
 * from the module cache the moment anything in the store graph has loaded, and
 * a failure to load it degrades to "this op is uncancellable" rather than to a
 * failed read.
 */
let cancellationModule: typeof StoreReadCancellation | null = null;

async function loadCancellation(): Promise<
  typeof StoreReadCancellation | null
> {
  if (cancellationModule) {
    return cancellationModule;
  }
  try {
    cancellationModule = await import("./store-read-cancellation.js");
    return cancellationModule;
  } catch {
    return null;
  }
}

/**
 * ISS-12022 — the result codec, reached through a DYNAMIC import for the same
 * reason as the cancellation registry above. A failure to load it degrades to
 * posting the plain value, which the dispatcher still accepts.
 */
let resultCodecModule: typeof ResultCodec | null = null;
let resultCodecLoadFailed = false;

async function loadResultCodec(): Promise<typeof ResultCodec | null> {
  if (resultCodecModule || resultCodecLoadFailed) {
    return resultCodecModule;
  }
  try {
    resultCodecModule = await import("./db-host-result-codec.js");
    return resultCodecModule;
  } catch (error) {
    resultCodecLoadFailed = true;
    post({
      kind: DbStoreResponseKind.Log,
      message: `db-host result codec failed to load; results cross as plain values: ${(await serializeStoreError(error)).message}`,
    });
    return null;
  }
}

function post(message: DbStoreResponse, transfer?: ArrayBuffer[]): void {
  parentPort?.postMessage(message, transfer);
}

/**
 * Flatten an error WITHOUT loading anything.
 *
 * The real serializer is `serializeDbHostError`, and {@link serializeStoreError}
 * below prefers it — it is the one that carries `refusalKind` and
 * `storageExhaustionReason`, which `db-host-client.ts` rebuilds a typed
 * `DesktopMigrationError` from. This fallback exists for the one case that
 * serializer cannot cover: the store module graph failed to load, so nothing
 * downstream of it can be imported either. That failure has no refusal kind and
 * no driver result code to carry, so the three fields below are the whole of it.
 */
function flattenBootstrapError(error: unknown): DbHostError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name };
  }
  return { message: String(error) };
}

/**
 * Serialize with the real serializer when it can be reached.
 *
 * Once the store module has loaded, `db-host-protocol.js` is already in the
 * module cache (the store's graph pulls it in), so this `import()` resolves
 * without touching disk and cannot fail. Before that it can, which is precisely
 * when {@link flattenBootstrapError} is the correct answer.
 */
async function serializeStoreError(error: unknown): Promise<DbHostError> {
  try {
    const { serializeDbHostError } = await import("./db-host-protocol.js");
    return serializeDbHostError(error);
  } catch {
    return flattenBootstrapError(error);
  }
}

async function handleOpen(request: DbStoreRequest): Promise<void> {
  if (request.kind !== DbStoreRequestKind.Open) {
    return;
  }
  try {
    const { createDbStoreHost } = await import("./db-store-host.js");
    host = createDbStoreHost({ post });
    await host.open(request.options);
    post({ kind: DbStoreResponseKind.Opened });
  } catch (error) {
    // Answer with an error and STAY ALIVE — see this file's header. The store is
    // left null, so any op that somehow follows fails with "db-host not
    // initialized" rather than against a half-open runtime.
    host = null;
    post({
      kind: DbStoreResponseKind.Opened,
      error: await serializeStoreError(error),
    });
  }
}

async function handleExecute(request: DbStoreRequest): Promise<void> {
  if (request.kind !== DbStoreRequestKind.Execute) {
    return;
  }
  const active = host;
  try {
    if (!active) {
      throw new Error("db-host not initialized");
    }
    // ISS-9802: bind the op to its cancellation token BEFORE it starts, so the
    // `yieldDbHostLoop()` checkpoints inside it can observe a cancel that
    // arrives while it runs. An op with no token enters no scope at all.
    const cancellation =
      request.cancellationToken === undefined ? null : await loadCancellation();
    const value = await (cancellation
      ? cancellation.runStoreReadUnderCancellation(
          request.cancellationToken,
          () => active.execute(request.op, request.args)
        )
      : active.execute(request.op, request.args));
    const codec = await loadResultCodec();
    // Publish the post-op memory sample BEFORE the result, so the dispatcher's
    // `measureOp` reads a fresh figure for this op rather than one up to a
    // sampling tick old. Same FIFO reasoning as the committed-write bump.
    active.publishMemorySample();
    if (codec) {
      codec.postEncodedStoreResult(post, request.id, value);
      return;
    }
    post({
      kind: DbStoreResponseKind.Result,
      id: request.id,
      ok: true,
      value,
    });
  } catch (error) {
    post({
      kind: DbStoreResponseKind.Result,
      id: request.id,
      ok: false,
      error: await serializeStoreError(error),
    });
  }
}

async function handleClose(): Promise<void> {
  try {
    await host?.close();
  } catch {
    // Closing is best-effort; the dispatcher terminates this thread next either
    // way, and a close failure must not cost it the ack it owes main.
  }
  host = null;
  post({ kind: DbStoreResponseKind.Closed });
}

async function handleRequest(request: DbStoreRequest): Promise<void> {
  switch (request.kind) {
    case DbStoreRequestKind.Open:
      await handleOpen(request);
      return;
    case DbStoreRequestKind.Execute:
      await handleExecute(request);
      return;
    case DbStoreRequestKind.SetIdentity:
      host?.setIdentity(request.identity);
      return;
    case DbStoreRequestKind.CancelRead: {
      // Best-effort: the op may already have settled, and a token naming nothing
      // in flight records nothing — which is also what bounds the registry.
      const cancellation = await loadCancellation();
      cancellation?.markStoreReadCancelled(request.token);
      return;
    }
    case DbStoreRequestKind.Close:
      await handleClose();
      return;
    default:
      return;
  }
}

// `parentPort` is null on the main thread, so the listener never binds there and
// this module stays importable by a test — the same seam
// `agent-session-sync-payload-worker.ts` uses.
//
// Requests are NOT awaited in order: two `Execute`s overlap exactly as they do
// on today's single-threaded db-host, where `handleMessage(data).catch(...)` is
// likewise fire-and-forget. Serialization is the write queue's job, not this
// listener's.
parentPort?.on("message", (message: unknown) => {
  if (!isDbStoreRequest(message)) {
    return;
  }
  handleRequest(message).catch(async (error: unknown) => {
    post({
      kind: DbStoreResponseKind.Log,
      message: (await serializeStoreError(error)).message,
    });
  });
});
