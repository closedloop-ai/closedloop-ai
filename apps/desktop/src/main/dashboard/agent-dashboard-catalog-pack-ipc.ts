/**
 * @file agent-dashboard-catalog-pack-ipc.ts
 * @description ISS-4771: the pack-lifecycle IPC channels — the vetted pack
 * catalog, the installed-pack inventory, the plan store, and the pull-request
 * store, including the two `streamRun` install/uninstall handlers and the two
 * `shell` open handlers with their path/URL allowlists. Extracted verbatim out of
 * `agent-dashboard-design-system-runtime.ts`; the
 * trust model (install commands come only from the local `pack_catalog`) is
 * unchanged.
 *
 * ISS-8143 changed three of the guards: the page windows on `get-plans-list`,
 * `get-pr-sessions` and `get-pr-list` now clamp through
 * `coerceDashboardListWindow` instead of forwarding the renderer's number raw.
 * Every other guard here is still the extracted original.
 */

import path from "node:path";
import { app, ipcMain, shell } from "electron";
import { AgentDashboardDbIpcChannel } from "../../shared/agent-dashboard-db-ipc-channel.js";
import type {
  InstalledPack,
  SkillInvocation,
  SkillWithInvocations,
} from "../../shared/agent-db-contract.js";
import {
  MAX_DASHBOARD_PLAN_PAGE_LIMIT,
  MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT,
  MAX_SESSION_PAGE_LIMIT,
} from "../database/db-constants.js";
import { coerceDashboardListWindow } from "../database/db-helpers.js";
import { registerCatalogConvertInstallHandler } from "../packs/catalog-convert-install-ipc.js";
import {
  getCatalog,
  listCatalog,
  listHistory,
  listInstallRuns,
} from "../packs/catalog-store.js";
import { streamRun } from "../packs/install-orchestrator.js";
import { rescanPacksAndNotify } from "../packs/pack-rescan-notify.js";
import {
  getPack,
  type PackSessionRow,
  PackStoreReadOp,
  type PackStoreReadResult,
} from "../packs/pack-store.js";
import { getPlan, getPlanVersions, listPlans } from "../plans/plan-store.js";
import { resolveOpenablePlanFilePath } from "../plans/safe-plan-file.js";
import {
  getPrStats,
  listPrSessions,
  listPullRequests,
} from "../pull-requests/pr-store.js";
import { isAllowedExternalUrl } from "../settings/external-url-allowlist.js";
import { coerceDashboardWindowRequest } from "./agent-dashboard-ipc-coercion.js";
import type {
  WithDb,
  WithPrisma,
} from "./agent-dashboard-ipc-handler-wrappers.js";
import type {
  AgentDashboardDesignSystemRuntimeOptions,
  InvokeStoreOp,
} from "./agent-dashboard-runtime-options.js";

/** Register the catalog, installed-pack, plan, and pull-request channels. */
export function registerCatalogAndPackIpcHandlers(deps: {
  withDb: WithDb;
  withPrisma: WithPrisma;
  options: AgentDashboardDesignSystemRuntimeOptions;
  invokeStoreOp: InvokeStoreOp;
}): void {
  const { withDb, withPrisma, options, invokeStoreOp } = deps;
  // --- Catalog (FEA-1314) ---
  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetCatalog,
    withPrisma((prisma) => listCatalog(prisma))
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetCatalogEntry,
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      return getCatalog(prisma, packId);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetCatalogContents,
    withPrisma(async (prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      const entry = await getCatalog(prisma, packId);
      if (!entry) {
        return null;
      }
      // FEA-2038: refreshCatalogContents can write, so run it in the DB host.
      // A null result means the refresh was unavailable and the existing cache
      // was left unchanged; callers can keep rendering any catalog row cache.
      const refreshed = await invokeStoreOp("catalog.contents.refresh", [
        entry,
      ]);
      return Array.isArray(refreshed) ? refreshed : null;
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetCatalogHistory,
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return [];
      }
      return listHistory(prisma, packId);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.CatalogInstall,
    withDb(
      async (
        agentDatabase,
        packId: unknown,
        harness: unknown,
        cwd?: unknown
      ) => {
        if (typeof packId !== "string" || typeof harness !== "string") {
          return { started: false };
        }
        return await streamRun(agentDatabase, {
          pack_id: packId,
          harness,
          action: "install",
          cwd: typeof cwd === "string" ? cwd : undefined,
          getWindow: options.getWindow,
          // FEA-2038: the CLI spawn + output streaming stays in main (streamRun
          // here); only the post-install rescan runs in the DB host. The
          // run-record writes now serialize via prisma.write on the one client.
          // ISS-6882: the rescan announces its commit, so the renderer's
          // component caches move off the new inventory.
          onComplete: () => {
            rescanPacksAndNotify({
              getWindow: options.getWindow,
              invokeStoreOp,
            });
          },
        });
      }
    )
  );

  // FEA-4079: convert a component to the target harness's format and install it,
  // as ONE gateway operation. Registered from a sibling module
  // (`packs/catalog-convert-install-ipc.ts`); it drives the convert engine over
  // the identical `streamRun` catalog install path.
  registerCatalogConvertInstallHandler({
    withDb,
    getWindow: options.getWindow,
    invokeStoreOp,
  });

  ipcMain.handle(
    AgentDashboardDbIpcChannel.CatalogUninstall,
    withDb(
      async (
        agentDatabase,
        packId: unknown,
        harness: unknown,
        cwd?: unknown
      ) => {
        if (typeof packId !== "string" || typeof harness !== "string") {
          return { started: false };
        }
        return await streamRun(agentDatabase, {
          pack_id: packId,
          harness,
          action: "uninstall",
          cwd: typeof cwd === "string" ? cwd : undefined,
          getWindow: options.getWindow,
          // FEA-2038: CLI spawn + streaming stay in main; only the post-uninstall
          // rescan runs in the DB host. Run-record writes go through prisma.write.
          // ISS-6882: the rescan announces its commit, so the renderer's
          // component caches move off the new inventory.
          onComplete: () => {
            rescanPacksAndNotify({
              getWindow: options.getWindow,
              invokeStoreOp,
            });
          },
        });
      }
    )
  );

  // FEA-2038: runCatalogFetch's prisma.write can't cross the method proxy, so
  // the whole fetch runs in the DB host. withDb keeps the DB-readiness await +
  // first-IPC signal that withPrisma provided.
  ipcMain.handle(
    AgentDashboardDbIpcChannel.CatalogRefresh,
    withDb(() => invokeStoreOp("catalog.fetch.run"))
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetInstallRuns,
    withPrisma((prisma, packId?: unknown) =>
      listInstallRuns(
        prisma,
        typeof packId === "string" ? { pack_id: packId } : {}
      )
    )
  );

  // --- Installed Packs (FEA-1224) ---

  // ISS-6753: these four page-facing pack/skill reads run on the DB host's
  // READER POOL, which takes a `prisma.read` callback the db-host proxy cannot
  // carry, so they go over `invokeStoreOp` rather than `withPrisma` (same reason
  // as `catalog-refresh` above). Each handler annotates its result from
  // `PackStoreReadResult`, so a channel wired to the wrong op does not compile.
  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetInstalledPacks,
    withDb(
      (): Promise<InstalledPack[]> =>
        readPackStore(invokeStoreOp, PackStoreReadOp.ListPacks)
    )
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPackDetail,
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      return getPack(prisma, packId);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPackSessions,
    withDb((_agentDatabase, packId: unknown): Promise<PackSessionRow[]> => {
      if (typeof packId !== "string") {
        return Promise.resolve([]);
      }
      return readPackStore(invokeStoreOp, PackStoreReadOp.ListPackSessions, [
        packId,
      ]);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetAllSkills,
    withDb(
      (): Promise<SkillWithInvocations[]> =>
        readPackStore(invokeStoreOp, PackStoreReadOp.ListSkills)
    )
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetSkillInvocations,
    withDb((_agentDatabase, name: unknown): Promise<SkillInvocation[]> => {
      if (typeof name !== "string") {
        return Promise.resolve([]);
      }
      return readPackStore(
        invokeStoreOp,
        PackStoreReadOp.ListSkillInvocations,
        [name]
      );
    })
  );

  // --- Plans (FEA-1189) ---

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPlansList,
    withPrisma((prisma, opts?: unknown) => {
      const o =
        typeof opts === "object" && opts !== null
          ? (opts as Record<string, unknown>)
          : {};
      // ISS-8143: the renderer is browser-side, so these bounds are untrusted at
      // runtime whatever the preload's types say. A plan row carries its full
      // `contentMarkdown`, so an unclamped `limit` is the whole-corpus response
      // ISS-5631 capped on the sibling channel — this routes through that same
      // pair rather than re-deriving a fourth window check.
      const window = coerceDashboardListWindow(
        coerceDashboardWindowRequest(opts),
        MAX_DASHBOARD_PLAN_PAGE_LIMIT
      );
      return listPlans(prisma, {
        sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
        needsConfirmation:
          typeof o.needsConfirmation === "boolean"
            ? o.needsConfirmation
            : undefined,
        limit: window.limit,
        offset: window.offset,
      });
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPlan,
    withPrisma((prisma, id: unknown) => {
      if (typeof id !== "string") {
        return null;
      }
      return getPlan(prisma, id);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPlanVersions,
    withPrisma((prisma, planId: unknown) => {
      if (typeof planId !== "string") {
        return [];
      }
      return getPlanVersions(prisma, planId);
    })
  );

  // FEA-2038: confirmPlan/rejectPlan use prisma.write — run in the DB host.
  ipcMain.handle(
    AgentDashboardDbIpcChannel.ConfirmPlan,
    withDb((_agentDatabase, id: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      return invokeStoreOp("plans.confirm", [id]);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.RejectPlan,
    withDb((_agentDatabase, id: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      return invokeStoreOp("plans.reject", [id]);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.OpenPlan,
    withPrisma(async (prisma, id: unknown, target?: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      const plan = await getPlan(prisma, id);
      if (!plan) {
        return;
      }
      const filePath = String(
        target === "log" ? plan.sourceLogPath : plan.filePath
      );
      if (filePath && filePath !== "null" && filePath !== "undefined") {
        // shell.openPath hands the path to the OS file association, which would
        // *execute* a `.command`/`.app`/script the store row points at. Only
        // open real files inside the agent homes with a non-executable
        // extension; reject anything else (poisoned sync record / spoofed row).
        const safePath = resolveOpenablePlanFilePath(filePath, [
          // Plan backfill roots plansDir at Electron's app home (see
          // backfillClaudePlans); include it so it is accepted even when
          // app.getPath("home") diverges from os.homedir().
          path.join(app.getPath("home"), ".claude"),
        ]);
        if (safePath) {
          // biome-ignore lint/complexity/noVoid: ISS-4771 moved this statement out of a file where `noVoid` is disabled; `void` is what satisfies noFloatingPromises here, and attaching a `.catch` instead would silently swallow a rejection the pre-extraction code let surface.
          void shell.openPath(safePath);
        } else {
          options.log?.(
            "agent-dashboard",
            `Refused to open plan path outside allowed roots: ${filePath}`
          );
        }
      }
    })
  );

  // --- Pull Requests (FEA-1226) ---

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPrStats,
    withPrisma((prisma) => getPrStats(prisma))
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPrSessions,
    withPrisma((prisma, opts?: unknown) => {
      // No `opts` projection here: this channel takes no filters, so the window
      // is the whole payload and `coerceDashboardWindowRequest` does the
      // object guard itself.
      //
      // ISS-8143: these two bounds are the positional binds of a raw
      // `LIMIT $1 OFFSET $2`. Parameterized, so never an injection — but an
      // unclamped negative, fractional, or 1e9 bound still reaches the engine.
      //
      // The ceiling is the SESSION one, not the pull-request one: this query
      // `GROUP BY`s on `session_id`, so its page counts SESSIONS. Both
      // constants are 100 today, which is exactly what would have hidden the
      // mismatch had the PR ceiling been used and later moved.
      const window = coerceDashboardListWindow(
        coerceDashboardWindowRequest(opts),
        MAX_SESSION_PAGE_LIMIT
      );
      return listPrSessions(prisma, {
        limit: window.limit,
        offset: window.offset,
      });
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPrList,
    withPrisma((prisma, opts?: unknown) => {
      const o =
        typeof opts === "object" && opts !== null
          ? (opts as Record<string, unknown>)
          : {};
      const window = coerceDashboardListWindow(
        coerceDashboardWindowRequest(opts),
        MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT
      );
      return listPullRequests(prisma, {
        sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
        repo: typeof o.repo === "string" ? o.repo : undefined,
        limit: window.limit,
        offset: window.offset,
      });
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.OpenPr,
    withPrisma(async (prisma, id: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      const prs = await listPullRequests(prisma);
      const pr = prs.find((p) => p.id === id);
      const prUrl = pr?.prUrl;
      if (typeof prUrl === "string" && isAllowedExternalUrl(prUrl)) {
        // biome-ignore lint/complexity/noVoid: ISS-4771 moved this statement out of a file where `noVoid` is disabled; `void` is what satisfies noFloatingPromises here, and attaching a `.catch` instead would silently swallow a rejection the pre-extraction code let surface.
        void shell.openExternal(prUrl);
      }
    })
  );
}

/**
 * ISS-6753 — invoke one {@link PackStoreReadOp} and return its declared result
 * type.
 *
 * `InvokeStoreOp` is `(name, args?) => Promise<unknown>`, so without this the
 * op-name→shape mapping is asserted separately at each call site with an `as`
 * the compiler never checks. Here the assertion is made ONCE, against the same
 * `PackStoreReadResult` map the db-host registry declares its handlers
 * `satisfies` — so the two ends cannot disagree, and no handler needs a cast.
 */
function readPackStore<K extends PackStoreReadOp>(
  invokeStoreOp: InvokeStoreOp,
  op: K,
  args?: unknown[]
): Promise<PackStoreReadResult[K]> {
  return invokeStoreOp(op, args) as Promise<PackStoreReadResult[K]>;
}
