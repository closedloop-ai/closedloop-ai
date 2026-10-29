/**
 * @file plans-list-window-ipc.test.ts
 * @description ISS-8143 — the PRODUCTION WIRING of `desktop:db:get-plans-list`'s
 * page window.
 *
 * The IPC edge is a trust boundary: the renderer is browser-side, so its
 * arguments are not constrained by TypeScript at runtime whatever
 * `preload-design-system.ts` declares. This channel used to forward
 * `typeof o.limit === "number" ? o.limit : undefined` with no finite, integer,
 * or range check, and `listPlans` put the value straight into Prisma `take` /
 * `skip`. A plan row is returned WITH its `versions.contentMarkdown`, so
 * `limit: 1e9` is the same whole-corpus-of-markdown response ISS-5631 capped on
 * the sibling `desktop:db:get-plans` channel.
 *
 * These cases drive the REAL registrar through the recording Electron stub and
 * the REAL `listPlans`, and assert on the `take`/`skip` Prisma actually
 * received — one layer past the store call, so neither the handler nor the
 * store can be the place the clamp silently goes missing.
 */

import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import type {
  WithDb,
  WithPrisma,
} from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { MAX_DASHBOARD_PLAN_PAGE_LIMIT } from "../src/main/database/db-constants.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

const PLANS_LIST_CHANNEL = "desktop:db:get-plans-list";
const TRUSTED_EVENT = { sender: {} };

let mock: ElectronModuleMock;
let registerCatalogAndPackIpcHandlers: (deps: {
  withDb: WithDb;
  withPrisma: WithPrisma;
  options: AgentDashboardDesignSystemRuntimeOptions;
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
}) => void;

beforeAll(async () => {
  mock = registerElectronModuleMock();
  // Dynamic, because the redirect must be installed before the registrar
  // evaluates its module-scope `import { app, ipcMain, shell } from "electron"`.
  const registrar = await import(
    "../src/main/dashboard/agent-dashboard-catalog-pack-ipc.js"
  );
  registerCatalogAndPackIpcHandlers =
    registrar.registerCatalogAndPackIpcHandlers as typeof registerCatalogAndPackIpcHandlers;
});

afterAll(() => {
  mock.deregister();
});

afterEach(() => {
  resetElectronModuleStub();
});

/** The `{ take, skip }` a single `plan.findMany` was issued with. */
type PlanFindManyArgs = { take?: unknown; skip?: unknown };

/**
 * Registers the real handlers over a prisma double whose `plan.findMany`
 * records its argument object. The assertion is then on what reached PRISMA,
 * not on the handler having run.
 */
function registerWithRecordingPrisma(): { issued: () => PlanFindManyArgs[] } {
  const issued: PlanFindManyArgs[] = [];
  const prisma = {
    client: {
      plan: {
        findMany: (args: PlanFindManyArgs) => {
          issued.push(args);
          return Promise.resolve([]);
        },
      },
    },
  };
  const withPrisma: WithPrisma =
    (handler) =>
    async (_event, ...args) =>
      await handler(
        prisma as unknown as Parameters<typeof handler>[0],
        ...args
      );
  const withDb: WithDb =
    (handler) =>
    async (_event, ...args) =>
      await handler(
        undefined as unknown as Parameters<typeof handler>[0],
        ...args
      );

  registerCatalogAndPackIpcHandlers({
    withDb,
    withPrisma,
    options: {} as AgentDashboardDesignSystemRuntimeOptions,
    invokeStoreOp: () => Promise.resolve(undefined),
  });
  return { issued: () => issued };
}

describe("ISS-8143 — get-plans-list clamps the renderer's page window", () => {
  // Each row is a window a renderer can send but the preload's types forbid,
  // paired with the `take`/`skip` the clamp must produce. Deleting the clamp
  // sends the raw value to Prisma and fails every row but the last.
  for (const { name, sent, take, skip } of [
    {
      name: "a whole-corpus limit is capped at the page ceiling",
      sent: { limit: 1e9 },
      take: MAX_DASHBOARD_PLAN_PAGE_LIMIT,
      skip: 0,
    },
    {
      name: "a negative limit floors at 1 rather than inverting the page",
      sent: { limit: -1 },
      take: 1,
      skip: 0,
    },
    {
      name: "a fractional limit truncates toward the caller's intent",
      sent: { limit: 1.5 },
      take: 1,
      skip: 0,
    },
    {
      name: "a negative offset floors at 0 rather than reading a suffix",
      sent: { limit: 10, offset: -1 },
      take: 10,
      skip: 0,
    },
    {
      name: "a non-finite limit falls back to the default window",
      sent: { limit: Number.NaN },
      take: MAX_DASHBOARD_PLAN_PAGE_LIMIT,
      skip: 0,
    },
    {
      name: "a legitimate window is forwarded untouched",
      sent: { limit: 25, offset: 50 },
      take: 25,
      skip: 50,
    },
  ]) {
    test(name, async () => {
      const { issued } = registerWithRecordingPrisma();

      await registeredInvokeHandler(PLANS_LIST_CHANNEL)(TRUSTED_EVENT, sent);

      assert.equal(
        issued().length,
        1,
        "the read must reach Prisma exactly once"
      );
      assert.equal(issued()[0].take, take);
      assert.equal(issued()[0].skip, skip);
    });
  }

  test("an absent window still reads the store's own default page", async () => {
    // The behaviour this change must NOT alter. `listPlans` destructures
    // `{ limit = 100, offset = 0 }` and the ceiling is 100, so routing through
    // `coerceDashboardListWindow` has to reproduce that exact page for a caller
    // that sends nothing — otherwise the fix is a silent product change.
    const { issued } = registerWithRecordingPrisma();

    await registeredInvokeHandler(PLANS_LIST_CHANNEL)(TRUSTED_EVENT);
    await registeredInvokeHandler(PLANS_LIST_CHANNEL)(TRUSTED_EVENT, {});
    await registeredInvokeHandler(PLANS_LIST_CHANNEL)(
      TRUSTED_EVENT,
      "nonsense"
    );

    for (const args of issued()) {
      assert.equal(args.take, MAX_DASHBOARD_PLAN_PAGE_LIMIT);
      assert.equal(args.skip, 0);
    }
    assert.equal(issued().length, 3);
  });

  test("the window clamp does not disturb the row filters", async () => {
    // `sessionId` / `needsConfirmation` share the payload with the bounds, so a
    // clamp that rebuilt the whole options object rather than just the window
    // would drop them and silently widen the read to every plan.
    const { issued } = registerWithRecordingPrisma();

    await registeredInvokeHandler(PLANS_LIST_CHANNEL)(TRUSTED_EVENT, {
      sessionId: "session-1",
      needsConfirmation: true,
      limit: 1e9,
    });

    assert.deepEqual((issued()[0] as { where?: unknown }).where, {
      createdFromSessionId: "session-1",
      needsConfirmation: true,
    });
    assert.equal(issued()[0].take, MAX_DASHBOARD_PLAN_PAGE_LIMIT);
  });
});
