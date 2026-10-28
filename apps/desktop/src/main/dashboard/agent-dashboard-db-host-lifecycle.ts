/**
 * @file agent-dashboard-db-host-lifecycle.ts
 * @description ISS-4771: the db-host lifecycle concern of the Agent Dashboard
 * design-system runtime, extracted out of
 * `agent-dashboard-design-system-runtime.ts`.
 *
 * It owns everything that wraps `DbHostClient`: the pre-open zombie-holder reap,
 * the child start, the forwarding `agentDatabase` proxy, the two `store:`-op
 * forwarders (including the FEA-3628 pack-scan interception), and the
 * `beginClosing()` / `close()` shutdown pair. The runtime keeps the ordering
 * decisions — WHEN it opens the intentional-shutdown window and WHEN it drains
 * the child relative to the collectors, IPC handlers, and timers it also owns —
 * this module only owns HOW each of those steps talks to the db host.
 *
 * Shutdown semantics are load-bearing and unchanged by the extraction:
 * `beginClosing()` is synchronous, cheap, and idempotent (it marks the
 * intentional-shutdown window so a db-host `exit` during teardown is not
 * relabeled unexpected or restarted), and `close()` performs the bounded clean
 * drain.
 */

import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import { dataRevisionFor } from "../collectors/engine/data-revision.js";
import { buildZombieDbHolderOsDeps } from "../database/database-integrity/zombie-db-holder-os.js";
import {
  makeOwnProcessMatcher,
  reapZombieDatabaseHolders,
} from "../database/database-integrity/zombie-db-holder-reaper.js";
import { createDbHostAgentDatabase } from "../database/db-host/db-host-agent-database.js";
import {
  DbHostClient,
  type DbHostForkFn,
} from "../database/db-host/db-host-client.js";
import { createDbHostIdentityPublisher } from "../database/db-host/db-host-identity-publisher.js";
import {
  DB_HOST_RESTART_EXHAUSTED_RUNTIME_STATUS,
  DB_HOST_RESTART_EXHAUSTED_USER_REASON,
} from "../database/db-host/db-host-restart-budget.js";
import { DB_HOST_STORE_OP_PREFIX } from "../database/db-host/db-host-store-op-registry.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { sendToRendererWindow } from "../ipc/renderer-ipc.js";
import { onFatalExit } from "../lifecycle/fatal-exit-notice.js";
import type { CatalogFetchCoordinator } from "../packs/catalog-fetch-coordinator.js";
import type { PackScanCoordinator } from "../packs/pack-scan-coordinator.js";
import { effectiveParsePolicy } from "../parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_SET_STORE_OP,
  type ParsePolicy,
} from "../parse-policy/parse-policy.js";
import {
  createParsePolicyPusher,
  subscribeParsePolicyFlips,
} from "../parse-policy/parse-policy-resolver.js";
import {
  reportDbHostExitedUnexpectedly,
  reportDbHostRestartExhausted,
} from "../telemetry/db-host-exit-telemetry.js";
import type {
  AgentDashboardDesignSystemRuntimeOptions,
  InvokeStoreOp,
} from "./agent-dashboard-runtime-options.js";
import { resolveAgentDashboardDatabasePath } from "./agent-dashboard-runtime-paths.js";
import { routeStoreOp } from "./store-op-router.js";

type AgentDashboardDbHostLifecycleDeps = {
  options: AgentDashboardDesignSystemRuntimeOptions;
  log: (scope: string, message: string) => void;
  /**
   * FEA-3628: read late — the coordinator is created by the runtime AFTER this
   * lifecycle (it needs `rawStoreOp`), so the pack-scan interception must read
   * the live value on every call exactly as the original closure did. Until it
   * exists — and in golden mode, where it never does — `packScanner.run`
   * forwards straight to the db-host fallback.
   */
  getPackScanCoordinator: () => PackScanCoordinator | null;
  /**
   * ISS-5274: read late for the same reason as the pack-scan coordinator — the
   * runtime builds it after this lifecycle, and golden mode never builds one,
   * in which case `catalog.fetch.run` forwards to the db-host fallback.
   */
  getCatalogCoordinator: () => CatalogFetchCoordinator | null;
  /**
   * ISS-5715 (review) — override how the db-host child is forked. Test-only
   * seam, mirroring `DbHostClient.fork` and forwarded to it verbatim: it lets a
   * suite construct the REAL lifecycle, deliver a REAL unexpected child exit,
   * and assert the telemetry emitter actually fired — the behavior the deleted
   * source-text guard only claimed to check. Nothing else changes: the reap, the
   * start sequence and every forwarder run exactly as in production. Undefined
   * in production, where the client forks a genuine `utilityProcess`.
   */
  fork?: DbHostForkFn;
};

export type AgentDashboardDbHostLifecycle = {
  /** The forwarding proxy: every `agentDatabase.*` call executes in the DB host. */
  agentDatabase: DbHostAgentDatabase;
  /** Resolves once the child has opened the database. */
  ready: Promise<DbHostAgentDatabase>;
  /** Forward a `store:`-prefixed op to the child, with NO interception. */
  rawStoreOp: InvokeStoreOp;
  /** Forward a `store:`-prefixed op, intercepting `packScanner.run` (FEA-3628). */
  invokeStoreOp: InvokeStoreOp;
  /**
   * ISS-4713 — mark the intentional-shutdown window open on the db-host client
   * synchronously, before the app tears down the capture/sync services that
   * still drive db-host writes. From here a db-host `exit` is treated as
   * expected (no "exited unexpectedly" relabel, no mid-shutdown restart).
   */
  beginClosing: () => void;
  /** The bounded, clean db-host drain. */
  close: () => Promise<void>;
  /**
   * ISS-9802 — ask the child to abandon the in-flight read carrying `token`.
   * Fire-and-forget; a token naming nothing in flight is a no-op on the child.
   */
  cancelRead: (token: string) => void;
  /**
   * ISS-4823 — is the db-host process currently reporting memory pressure? The
   * DATA_REVISION rebuild's adaptive write-pause reads this so it backs off
   * while the child is squeezed. The client answers from a cached sample and
   * ages it out, so a stale sample reads as "not under pressure" (fail-open:
   * pressure must never be inferred from silence).
   */
  isUnderMemoryPressure: () => boolean;
};

/**
 * FEA-3625: before the db-host opens the SQLite file, reap any suspended/zombie
 * process of THIS app that is still holding the DB (or its `-wal`/`-shm`
 * sidecars) hostage after an unclean shutdown — the automated form of the
 * `kill-desktop-zombies` operator workaround. Scoped, safe, and best-effort: it
 * never kills a live/running instance and never throws, so a failure here can
 * never block boot (the db-host open then surfaces any residual lock the normal
 * way). No-op on unsupported platforms (Windows).
 */
async function reapZombieDbHoldersBeforeOpen(
  dbPath: string,
  log: (namespace: string, message: string) => void
): Promise<void> {
  const osDeps = buildZombieDbHolderOsDeps(process.platform, (message) =>
    log("agent-sqlite", message)
  );
  if (!osDeps) {
    return;
  }
  try {
    const result = await reapZombieDatabaseHolders(dbPath, {
      ...osDeps,
      // Scope the own-process match to our exact DB directory too, so a dev-mode
      // holder whose executable path is the node_modules Electron binary (no
      // product name) is still recognized as ours.
      isOwnProcessCommand: makeOwnProcessMatcher(dbPath),
    });
    if (result.reaped.length > 0) {
      log(
        "agent-sqlite",
        `zombie-db-reaper: released SQLite lock by reaping ${result.reaped.length} stale holder(s): ${result.reaped.join(
          ", "
        )}`
      );
    }
  } catch (error) {
    // reapZombieDatabaseHolders is already non-throwing, but keep the boot path
    // bulletproof: a cleanup failure must never prevent the DB from opening.
    log(
      "agent-sqlite",
      `zombie-db-reaper: unexpected failure (continuing to open DB): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * FEA-2038: SQLite + Prisma + all stores run in a dedicated utilityProcess (the
 * DB host) so the 6–20 GB first-launch backfill never blocks the main thread.
 * The child opens the DB (with billing-mode/git resolvers wired on its side);
 * main only forwards calls and relays the child's change events.
 */
export function createAgentDashboardDbHostLifecycle(
  deps: AgentDashboardDbHostLifecycleDeps
): AgentDashboardDbHostLifecycle {
  const { options, log, getPackScanCoordinator, getCatalogCoordinator, fork } =
    deps;
  const dbHost = new DbHostClient({
    fork,
    onEmit: (sessionId: string) => {
      // The child already invalidated its own session caches before emitting;
      // here we only nudge the renderer to refetch.
      sendToRendererWindow(
        options.getWindow(),
        DesktopRendererEventChannel.DbChanged,
        {
          sessionId,
        }
      );
    },
    onSessionTerminal: options.onSessionTerminal,
    onLog: (message: string) => log("agent-sqlite", message),
    // ISS-5715: the child went away while consumers were still attached. The
    // log line above stays on the user's machine, and the three consumers that
    // die with it (collector live import, transcript sync, the Sessions
    // page-data read) fail where only the last one is visible — so route it to
    // the telemetry path too, carrying how many in-flight ops were dropped.
    // That makes the exit queryable in Datadog; the alert on top of it is a
    // companion monitor in `example-infrastructure` (see db-host-exit-telemetry.ts).
    onUnexpectedExit: (event) => reportDbHostExitedUnexpectedly(event),
    // ISS-8776: the ladder gave up. Separate sinks, because the audiences are
    // different and none substitutes for another — the telemetry event so a
    // shipped app's unrecoverable store is QUERYABLE rather than known only to
    // the machine it happened on (queryable, not alerting: the companion
    // `datadog_monitor` is ISS-8242 and has not landed — whitlockk, #6432), and
    // `onTerminalFailure` so the user is told, through the SAME Agent Monitor
    // notification + tray path a boot-time DB refusal already uses. Reusing that
    // channel is the point: a terminal store failure is a terminal store failure
    // whether it happens at open or eight restarts later.
    // THREE sinks, not two (davetho, #6432). The notification and the tray
    // are a one-shot the user can miss or dismiss; `desktop:get-runtime-status`
    // is the standing answer every renderer surface polls, and a boot that
    // reached `ready` has already latched it there. Left alone it keeps
    // reporting healthy for the rest of a session whose local store is gone —
    // the same "never let the UI lie about state" line the boot-time refusal
    // path already holds by publishing a failed status of its own.
    onRestartExhausted: (event) => {
      reportDbHostRestartExhausted(event);
      options.setAgentMonitorRuntimeStatus(
        DB_HOST_RESTART_EXHAUSTED_RUNTIME_STATUS
      );
      options.onTerminalFailure(DB_HOST_RESTART_EXHAUSTED_USER_REASON);
    },
  });
  // ISS-8776: `app.exit()` from the process error handlers skips `before-quit`,
  // so the graceful shutdown that calls `beginClosing()` never runs on the fatal
  // path. Registered HERE, beside the client it tears down, so the hook cannot
  // outlive its subject — both graceful entry points release it below before
  // doing their own teardown.
  const releaseFatalExitHook = onFatalExit(() => dbHost.beginClosing());
  // Forwarding proxy: every consumer keeps calling `agentDatabase.*` unchanged,
  // but each call executes in the DB host over IPC.
  const agentDatabase = createDbHostAgentDatabase(dbHost);
  const dbPath = resolveAgentDashboardDatabasePath(options.userDataPath);
  // ISS-6243 supersedes the ISS-6168 poll (`startDbHostIdentityWatch`) with the
  // same contract driven by a real signal. That watch existed because "the
  // resolver exposes no completion signal" — this change ADDS one
  // (`subscribeUserIdentityChanged`, fanned out from the credential store and
  // the `/me` resolver), so a 5s keychain-read poll that gave up after five
  // minutes and only ever fired once is now both redundant and strictly weaker:
  // it could not see a sign-out, an org switch that kept the same user id, or
  // any transition after its single push. Keeping both would leave two writers
  // racing to set the same child-side state.
  //
  // ISS-6168's load-bearing lesson is PRESERVED, not dropped: the baseline is
  // the identity the child actually OPENED with (`seedFromChildOpen` below),
  // never the publisher's own first read — the resolver can warm between
  // `dbHost.start` and the child reporting ready, and comparing against a first
  // read would skip the push on exactly the boots where it landed in that
  // window.
  const identityPublisher = createDbHostIdentityPublisher({
    getIdentity: () => options.getUserIdentity?.() ?? null,
    setIdentity: (identity) => dbHost.setUserIdentity(identity),
  });
  const unsubscribeIdentity = options.subscribeUserIdentityChanged?.(() =>
    identityPublisher.sync()
  );
  // ISS-12552 (PRD-800 "Rollout"): subscribed here, before `start` reads
  // the policy below, so no settled flip can land between that read and a
  // subscription: one before `start` is in what it reads, one after reaches
  // the child (queued until it is ready) and the retained init options.
  const pushConfirmed = createParsePolicyPusher({
    push: (policy) => pushParsePolicy(policy),
    expectedRevision: dataRevisionFor,
    log: (message) => log("agent-sqlite", message),
  });
  const unsubscribeParsePolicy = subscribeParsePolicyFlips((policy) => {
    pushConfirmed(policy).catch(() => undefined);
  });
  // Releasing the identity subscription is NOT solely close()'s job. When
  // `ready` rejects, runtime creation throws before any close handle reaches the
  // caller, so close() is never called and this subscription — plus every value
  // the publisher retains — would stay attached to the credential store and the
  // resolver for the rest of the process lifetime. Idempotent: unsubscribe is a
  // Set delete and stop() only re-latches.
  const releaseIdentityWatch = (): void => {
    unsubscribeIdentity?.();
    identityPublisher.stop();
    unsubscribeParsePolicy();
  };
  const ready = reapZombieDbHoldersBeforeOpen(dbPath, log)
    // Read the identity HERE rather than before the reap: the reap shells out to
    // `lsof`, so a `/me` landing during it would otherwise be published into a
    // client that has not started, and then overwritten by a stale Init snapshot.
    .then(() => {
      const identity = options.getUserIdentity?.() ?? null;
      identityPublisher.seedFromChildOpen(identity);
      return dbHost.start({
        dataDir: dbPath,
        identity,
        parsePolicy: effectiveParsePolicy(),
      });
    })
    .then(
      () => {
        // Reconcile once the child is live: anything that resolved or was
        // retired while the reap and the Init handshake ran is republished here,
        // measured against what the child opened with.
        identityPublisher.sync();
        return agentDatabase;
      },
      (error: unknown) => {
        // ISS-8776: the fatal-exit hook is released here for exactly the reason
        // the comment above gives for the identity watch — a `ready` rejection
        // throws out of runtime creation before any close handle reaches the
        // caller, so neither `beginClosing()` nor `close()` ever runs and the
        // hook would stay registered for the life of the process.
        //
        // But the CHILD is not necessarily gone with it (codex, #6432). A store
        // that refuses to open — a migration refusal, a storage-exhaustion
        // classification — is answered by the worker with a `Ready` carrying an
        // error and STAYING ALIVE (`db-host-worker.ts`, PLN-1837 §1.2), because
        // the refusal is deterministic and exiting would refuse again on every
        // restart. `DbHostClient` retains that child too. Releasing the hook
        // without more would therefore leave a live utility process behind with
        // nothing left to announce a fatal teardown to it: `app.exit()` kills
        // the child, `handleExit()` sees neither `closing` nor `closed`, and the
        // supervisor relabels it a crash and re-forks into a dying main process
        // — the exact loop this ticket exists to stop.
        //
        // So mark the intentional-shutdown window BEFORE letting the hook go.
        // `beginClosing()` is synchronous, cheap and idempotent, and it is
        // honest here rather than merely convenient: the runtime never reached
        // any consumer (DB IPC is registered in its DISABLED form on this path),
        // nothing re-arms `ready`, so no restart of this child could deliver a
        // store to anyone. A later exit of it is expected by construction.
        dbHost.beginClosing();
        releaseFatalExitHook();
        releaseIdentityWatch();
        throw error;
      }
    );

  // FEA-2038: store ops whose store fn takes a callback (prisma.write) can't run
  // over the method proxy — a function can't cross IPC. They execute wholly in
  // the DB host via `store:`-prefixed invokes.
  // Which of them may still cross a CLOSING client is the client's own call
  // (`db-host-shutdown-admission.ts`), keyed on the prefixed op name.
  const rawStoreOp = (name: string, args: unknown[] = []): Promise<unknown> =>
    dbHost.invoke(`${DB_HOST_STORE_OP_PREFIX}${name}`, args);
  function pushParsePolicy(policy: ParsePolicy): Promise<unknown> {
    dbHost.retainParsePolicy(policy);
    return rawStoreOp(PARSE_POLICY_SET_STORE_OP, [policy]);
  }
  // FEA-3628 / ISS-5274: intercept the pack-scan and catalog-fetch triggers so
  // their heavy work runs in the main process (off the db-host) and redundant
  // triggers coalesce. Every other store op forwards to the db-host unchanged.
  // The decision itself lives in `store-op-router.ts` so it can be executed by
  // a test — this module forks a real db-host and cannot be imported by one.
  const invokeStoreOp = (
    name: string,
    args: unknown[] = []
  ): Promise<unknown> =>
    routeStoreOp(name, args, {
      packScanCoordinator: getPackScanCoordinator(),
      catalogCoordinator: getCatalogCoordinator(),
      rawStoreOp,
    });

  return {
    agentDatabase,
    ready,
    rawStoreOp,
    invokeStoreOp,
    // Drop the identity subscription and every value it retained at BOTH
    // shutdown entry points (ISS-6168), and before the drain, so an identity
    // change landing mid-teardown cannot push a SetUserIdentity into a child
    // that is being closed.
    beginClosing: () => {
      releaseFatalExitHook();
      releaseIdentityWatch();
      dbHost.beginClosing();
    },
    close: () => {
      releaseFatalExitHook();
      releaseIdentityWatch();
      return dbHost.close();
    },
    isUnderMemoryPressure: () => dbHost.isUnderMemoryPressure(),
    cancelRead: (token: string) => dbHost.cancelRead(token),
  };
}
