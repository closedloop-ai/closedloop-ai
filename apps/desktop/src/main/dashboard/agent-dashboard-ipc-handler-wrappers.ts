/**
 * @file agent-dashboard-ipc-handler-wrappers.ts
 * @description ISS-4771: the two wrappers EVERY `desktop:db:*` handler is built
 * from — `withDb` (sender-trust gate + DB-readiness await + the first-IPC and
 * renderer-read signals) and `withPrisma` (the same, narrowed to the clone-safe
 * Prisma reader). Extracted out of the shrink-only grandfathered
 * `agent-dashboard-design-system-runtime.ts` so the per-domain handler-group
 * modules can each be handed the SAME wrappers instead of re-implementing the
 * trust gate. The gate itself is unchanged.
 */
import type { IpcMainInvokeEvent } from "electron";
import {
  DB_HOST_SHUTTING_DOWN_RESULT,
  type DbHostShuttingDownResult,
} from "../../shared/db-host-shutdown-contract.js";
import { isDbHostShutdownError } from "../../shared/db-host-shutdown-error.js";
import { redriveOnDbHostExit } from "../database/db-host/db-host-exit-redrive.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";

/**
 * What every `desktop:db:*` handler resolves with: its own result, or the
 * ISS-5262 shutdown sentinel when the db-host went away mid-read. The union is
 * on the WRAPPER, not on each handler, so no handler body has to know the
 * sentinel exists.
 */
export type WithDbResult<TResult> = TResult | DbHostShuttingDownResult;

/**
 * Gates sender trust, resolves the agent database, and forwards it plus the IPC
 * args to the handler.
 */
/**
 * ISS-5808 — per-handler wrapper options.
 *
 * `redriveOnHostExit` is OPT-IN, not the default, and the asymmetry is
 * deliberate. When the db-host child dies under a handler, re-running that
 * handler against the replacement child is exactly right for a READ (it recomputes
 * from the same rows) and is NOT safe in general for a handler that writes: the
 * child can have committed before it died, so a blind re-run double-applies. Only
 * a caller that knows its handler is a pure read — or idempotent by construction
 * — may set this.
 */
export type WithDbOptions = {
  /**
   * Re-run this handler when the db-host child exits mid-read AND the supervisor
   * has already armed a replacement fork. Bounded by attempt count
   * ({@link DB_HOST_EXIT_MAX_ATTEMPTS}); an exhausted re-drive still rejects.
   */
  readonly redriveOnHostExit?: boolean;
};

export type WithDb = <TArgs extends unknown[], TResult>(
  handler: (
    agentDatabase: DbHostAgentDatabase,
    ...args: TArgs
  ) => TResult | Promise<TResult>,
  options?: WithDbOptions
) => (
  event: IpcMainInvokeEvent,
  ...args: TArgs
) => Promise<WithDbResult<TResult>>;

/** {@link WithDb}, narrowed to the clone-safe Prisma reader. */
export type WithPrisma = <TArgs extends unknown[], TResult>(
  handler: (
    prisma: DbHostAgentDatabase["prisma"],
    ...args: TArgs
  ) => TResult | Promise<TResult>,
  options?: WithDbOptions
) => (
  event: IpcMainInvokeEvent,
  ...args: TArgs
) => Promise<WithDbResult<TResult>>;

/**
 * ISS-5808 — the opt-in every PURE-READ `desktop:db:*` handler passes as its
 * second `withDb` argument.
 *
 * A shared const rather than an inline object literal at each call site, so the
 * set of handlers that may replay is greppable in one search and a write handler
 * cannot acquire the behaviour by copy-paste of a plausible-looking literal.
 */
export const DB_HOST_EXIT_REDRIVE_READ: WithDbOptions = {
  redriveOnHostExit: true,
};

export type DbIpcHandlerWrappers = {
  withDb: WithDb;
  withPrisma: WithPrisma;
};

type CreateDbIpcHandlerWrappersDeps = {
  getAgentDatabase: () => Promise<DbHostAgentDatabase>;
  options: AgentDashboardDesignSystemRuntimeOptions;
};

/**
 * Build the `withDb`/`withPrisma` pair for one registration pass. The
 * `firstDbIpcServed` latch is per-pass, exactly as it was when both wrappers
 * were closures inside `registerDesignSystemDbIpcHandlers`.
 */
export function createDbIpcHandlerWrappers(
  deps: CreateDbIpcHandlerWrappersDeps
): DbIpcHandlerWrappers {
  const { getAgentDatabase, options } = deps;

  let firstDbIpcServed = false;
  const notifyFirstDbIpcServed = (): void => {
    if (firstDbIpcServed) {
      return;
    }
    firstDbIpcServed = true;
    options.onFirstDbIpcServed?.();
  };

  const withDb: WithDb =
    <TArgs extends unknown[], TResult>(
      handler: (
        agentDatabase: DbHostAgentDatabase,
        ...args: TArgs
      ) => TResult | Promise<TResult>,
      handlerOptions?: WithDbOptions
    ) =>
    async (
      event: IpcMainInvokeEvent,
      ...args: TArgs
    ): Promise<WithDbResult<TResult>> => {
      // Sender trust gates the entire handler (matches gateway-dispatch-ipc and
      // renderer-otel-ipc). Reject IPC from any frame other than the trusted
      // renderer before touching the DB so a compromised renderer cannot reach
      // host-side handlers like open-plan/open-pr.
      if (!options.isTrustedSender(event.sender)) {
        throw new Error("untrusted sender");
      }
      let result: TResult;
      const runHandler = async (): Promise<TResult> =>
        await handler(await getAgentDatabase(), ...args);
      try {
        // ISS-5808: an opted-in READ rides out an unexpected db-host exit
        // instead of surfacing one. `desktop:db:get-insights` rejected three
        // times in the same millisecond band on 2026-08-10 — six section
        // queries mount concurrently, all were in flight when the child died,
        // and each printed `Error occurred in handler for …` and then leaned on
        // the renderer's React Query ladder to recover. Re-driving here parks
        // on `DbHostClient.ready` (pending for the whole crash-ladder backoff)
        // and resumes on the replacement child, so the read succeeds instead of
        // round-tripping a failure to the renderer. Writes never opt in — see
        // WithDbOptions.
        result = handlerOptions?.redriveOnHostExit
          ? await redriveOnDbHostExit(runHandler, {
              label: "db ipc read",
              log: (message) => options.log?.("agent-dashboard", message),
            })
          : await runHandler();
      } catch (error) {
        // ISS-5262: a read that raced the db-host teardown is not a handler
        // FAILURE, but `ipcMain.handle` prints
        // `Error occurred in handler for '<channel>'` for any rejection — which
        // is how `desktop:shared-agent-sessions:usage` spammed the log several
        // times AFTER `shutdown sequence end: clean`. Resolve the payload-free
        // sentinel instead so the log stops contradicting itself.
        //
        // Only a POSITIVELY classified shutdown error is converted. Every other
        // error still rejects exactly as before — a genuine query failure must
        // never be laundered into "we were shutting down".
        if (isDbHostShutdownError(error)) {
          return DB_HOST_SHUTTING_DOWN_RESULT;
        }
        throw error;
      }
      notifyFirstDbIpcServed();
      // ISS-4711: mark the renderer as actively served so the DATA_REVISION
      // rebuild's adaptive pause treats a trusted programmatic/polling read —
      // which fires no user-input event — as active UI, holding the full pause.
      options.onRendererDbRead?.();
      return result;
    };

  // Hands a store handler the clone-safe Prisma reader (prisma.client). Writes
  // can't cross the db-host proxy, so they run in the child via invokeStoreOp,
  // never here; DbHostPrisma omits prisma.read/write so that is a compile error.
  const withPrisma: WithPrisma = <TArgs extends unknown[], TResult>(
    handler: (
      prisma: DbHostAgentDatabase["prisma"],
      ...args: TArgs
    ) => TResult | Promise<TResult>,
    // ISS-5808: threaded through, not dropped. Every `withPrisma` handler is a
    // read by construction (writes cannot cross the db-host proxy, and
    // `DbHostPrisma` omits `read`/`write` so a write is a compile error), so
    // these are exactly the handlers `DB_HOST_EXIT_REDRIVE_READ` is for —
    // swallowing the option here would silently exclude every one of them.
    handlerOptions?: WithDbOptions
  ) =>
    withDb(
      (agentDatabase, ...args: TArgs) => handler(agentDatabase.prisma, ...args),
      handlerOptions
    );

  return { withDb, withPrisma };
}
