/**
 * @file agent-dashboard-catalog-pack-ipc.ts
 * @description ISS-4771: the pack-lifecycle IPC channels — the vetted pack
 * catalog, the installed-pack inventory, the plan store, and the pull-request
 * store, including the two `streamRun` install/uninstall handlers and the two
 * `shell` open handlers with their path/URL allowlists. Extracted verbatim out of
 * the shrink-only grandfathered `agent-dashboard-design-system-runtime.ts`; the
 * trust model (install commands come only from the local `pack_catalog`) and
 * every guard are unchanged.
 */

import path from "node:path";
import { app, ipcMain, shell } from "electron";
import { registerCatalogConvertInstallHandler } from "../packs/catalog-convert-install-ipc.js";
import {
  getCatalog,
  listCatalog,
  listHistory,
  listInstallRuns,
} from "../packs/catalog-store.js";
import { streamRun } from "../packs/install-orchestrator.js";
import {
  getPack,
  listPackSessions,
  listPacks,
  listSkillInvocations,
  listSkills,
} from "../packs/pack-store.js";
import { getPlan, getPlanVersions, listPlans } from "../plans/plan-store.js";
import { resolveOpenablePlanFilePath } from "../plans/safe-plan-file.js";
import {
  getPrStats,
  listPrSessions,
  listPullRequests,
} from "../pull-requests/pr-store.js";
import { isAllowedExternalUrl } from "../settings/external-url-allowlist.js";
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
    "desktop:db:get-catalog",
    withPrisma((prisma) => listCatalog(prisma))
  );

  ipcMain.handle(
    "desktop:db:get-catalog-entry",
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      return getCatalog(prisma, packId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-catalog-readme",
    withPrisma(async (prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      const entry = await getCatalog(prisma, packId);
      return entry?.readmeExcerpt ?? null;
    })
  );

  ipcMain.handle(
    "desktop:db:get-catalog-contents",
    withPrisma(async (prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      const entry = await getCatalog(prisma, packId);
      if (!entry) {
        return null;
      }
      // FEA-2038: refreshCatalogContents ends in prisma.write — run it in the DB
      // host (it can't cross the method proxy). The reads stay on the proxy.
      await invokeStoreOp("catalog.contents.refresh", [entry]);
      const refreshed = await getCatalog(prisma, packId);
      return refreshed?.contentsCache ?? null;
    })
  );

  ipcMain.handle(
    "desktop:db:get-catalog-history",
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return [];
      }
      return listHistory(prisma, packId);
    })
  );

  ipcMain.handle(
    "desktop:db:catalog-install",
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
          onComplete: () => invokeStoreOp("packScanner.run").catch(() => {}),
        });
      }
    )
  );

  // FEA-4079: convert a component to the target harness's format and install it,
  // as ONE gateway operation. Registered from a sibling module (extracted to keep
  // this shrink-only grandfathered file trending smaller); it drives the convert
  // engine over the identical `streamRun` catalog install path.
  registerCatalogConvertInstallHandler({
    withDb,
    getWindow: options.getWindow,
    invokeStoreOp,
  });

  ipcMain.handle(
    "desktop:db:catalog-uninstall",
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
          onComplete: () => invokeStoreOp("packScanner.run").catch(() => {}),
        });
      }
    )
  );

  // FEA-2038: runCatalogFetch's prisma.write can't cross the method proxy, so
  // the whole fetch runs in the DB host. withDb keeps the DB-readiness await +
  // first-IPC signal that withPrisma provided.
  ipcMain.handle(
    "desktop:db:catalog-refresh",
    withDb(() => invokeStoreOp("catalog.fetch.run"))
  );

  ipcMain.handle(
    "desktop:db:get-install-runs",
    withPrisma((prisma, packId?: unknown) =>
      listInstallRuns(
        prisma,
        typeof packId === "string" ? { pack_id: packId } : {}
      )
    )
  );

  // --- Installed Packs (FEA-1224) ---

  ipcMain.handle(
    "desktop:db:get-installed-packs",
    withPrisma((prisma) => listPacks(prisma))
  );

  ipcMain.handle(
    "desktop:db:get-pack-detail",
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      return getPack(prisma, packId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-pack-sessions",
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return [];
      }
      return listPackSessions(prisma, packId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-all-skills",
    withPrisma((prisma) => listSkills(prisma))
  );

  ipcMain.handle(
    "desktop:db:get-skill-invocations",
    withPrisma((prisma, name: unknown) => {
      if (typeof name !== "string") {
        return [];
      }
      return listSkillInvocations(prisma, name);
    })
  );

  ipcMain.handle(
    "desktop:db:get-recent-projects",
    withPrisma(async (prisma) => {
      const rows = await prisma.client.$queryRawUnsafe<{ cwd: string }[]>(
        `SELECT cwd
       FROM sessions
       WHERE cwd IS NOT NULL AND cwd != ''
       GROUP BY cwd
       ORDER BY MAX(started_at) DESC NULLS LAST
       LIMIT 20`
      );
      return rows.map((r) => r.cwd);
    })
  );

  // --- Plans (FEA-1189) ---

  ipcMain.handle(
    "desktop:db:get-plans-list",
    withPrisma((prisma, opts?: unknown) => {
      const o =
        typeof opts === "object" && opts !== null
          ? (opts as Record<string, unknown>)
          : {};
      return listPlans(prisma, {
        sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
        needsConfirmation:
          typeof o.needsConfirmation === "boolean"
            ? o.needsConfirmation
            : undefined,
        limit: typeof o.limit === "number" ? o.limit : undefined,
        offset: typeof o.offset === "number" ? o.offset : undefined,
      });
    })
  );

  ipcMain.handle(
    "desktop:db:get-plan",
    withPrisma((prisma, id: unknown) => {
      if (typeof id !== "string") {
        return null;
      }
      return getPlan(prisma, id);
    })
  );

  ipcMain.handle(
    "desktop:db:get-plan-versions",
    withPrisma((prisma, planId: unknown) => {
      if (typeof planId !== "string") {
        return [];
      }
      return getPlanVersions(prisma, planId);
    })
  );

  // FEA-2038: confirmPlan/rejectPlan use prisma.write — run in the DB host.
  ipcMain.handle(
    "desktop:db:confirm-plan",
    withDb((_agentDatabase, id: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      return invokeStoreOp("plans.confirm", [id]);
    })
  );

  ipcMain.handle(
    "desktop:db:reject-plan",
    withDb((_agentDatabase, id: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      return invokeStoreOp("plans.reject", [id]);
    })
  );

  ipcMain.handle(
    "desktop:db:open-plan",
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
    "desktop:db:get-pr-stats",
    withPrisma((prisma) => getPrStats(prisma))
  );

  ipcMain.handle(
    "desktop:db:get-pr-sessions",
    withPrisma((prisma, opts?: unknown) => {
      const o =
        typeof opts === "object" && opts !== null
          ? (opts as Record<string, unknown>)
          : {};
      return listPrSessions(prisma, {
        limit: typeof o.limit === "number" ? o.limit : undefined,
        offset: typeof o.offset === "number" ? o.offset : undefined,
      });
    })
  );

  ipcMain.handle(
    "desktop:db:get-pr-list",
    withPrisma((prisma, opts?: unknown) => {
      const o =
        typeof opts === "object" && opts !== null
          ? (opts as Record<string, unknown>)
          : {};
      return listPullRequests(prisma, {
        sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
        repo: typeof o.repo === "string" ? o.repo : undefined,
        limit: typeof o.limit === "number" ? o.limit : undefined,
        offset: typeof o.offset === "number" ? o.offset : undefined,
      });
    })
  );

  ipcMain.handle(
    "desktop:db:open-pr",
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
