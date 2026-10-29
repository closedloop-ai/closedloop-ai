/**
 * @file pr-list-window-ipc.test.ts
 * @description ISS-8143 — the PRODUCTION WIRING of the two pull-request page
 * windows, `desktop:db:get-pr-sessions` and `desktop:db:get-pr-list`.
 *
 * Same defect class as `plans-list-window-ipc.test.ts` on a second and third
 * channel. `listPrSessions` drops the renderer's number into
 * `$queryRawUnsafe(… LIMIT $1 OFFSET $2, limit, offset)` — parameterized, so
 * never an injection, but an unclamped negative, fractional, or 1e9 bound still
 * reached the engine. `listPullRequests` forwards to `findPrArtifacts`, whose
 * `take` is Prisma's.
 *
 * The raw-SQL channel is asserted on the two POSITIONAL BINDS rather than on
 * the store call, because those binds are the values the engine actually sees.
 */

import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import type {
  WithDb,
  WithPrisma,
} from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT,
  MAX_SESSION_PAGE_LIMIT,
} from "../src/main/database/db-constants.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

const PR_SESSIONS_CHANNEL = "desktop:db:get-pr-sessions";
const PR_LIST_CHANNEL = "desktop:db:get-pr-list";
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

type ArtifactFindManyArgs = { take?: unknown; skip?: unknown };
/** The `[limit, offset]` bound into one `LIMIT $1 OFFSET $2`. */
type RawBinds = { limit: unknown; offset: unknown };

function registerWithRecordingPrisma(): {
  rawBinds: () => RawBinds[];
  artifactReads: () => ArtifactFindManyArgs[];
} {
  const rawBinds: RawBinds[] = [];
  const artifactReads: ArtifactFindManyArgs[] = [];
  const prisma = {
    client: {
      $queryRawUnsafe: (_sql: string, limit: unknown, offset: unknown) => {
        rawBinds.push({ limit, offset });
        // No grouped rows, so the per-session fan-out below never runs and the
        // only `artifact.findMany` a case sees is the one it asked for.
        return Promise.resolve([]);
      },
      artifact: {
        findMany: (args: ArtifactFindManyArgs) => {
          artifactReads.push(args);
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
  return { rawBinds: () => rawBinds, artifactReads: () => artifactReads };
}

/**
 * One row per window a renderer can send but the preload's types forbid.
 *
 * `ceiling` is passed per channel rather than hardcoded, because the two
 * channels page DIFFERENT UNITS: `get-pr-list` pages pull-request rows, while
 * `get-pr-sessions` `GROUP BY`s on `session_id` and pages SESSIONS. Both
 * constants happen to be 100 today, so a suite that assumed one ceiling for
 * both would stay green through exactly the drift that makes them differ.
 */
const hostileWindows = (ceiling: number) => [
  {
    name: "a whole-corpus limit is capped at the page ceiling",
    sent: { limit: 1e9 },
    limit: ceiling,
    offset: 0,
  },
  {
    name: "a negative limit floors at 1",
    sent: { limit: -1 },
    limit: 1,
    offset: 0,
  },
  {
    name: "a fractional limit truncates",
    sent: { limit: 7.9 },
    limit: 7,
    offset: 0,
  },
  {
    name: "a negative offset floors at 0",
    sent: { limit: 10, offset: -1 },
    limit: 10,
    offset: 0,
  },
  {
    name: "a legitimate window is forwarded untouched",
    sent: { limit: 20, offset: 40 },
    limit: 20,
    offset: 40,
  },
];

describe("ISS-8143 — get-pr-sessions clamps its raw-SQL binds", () => {
  for (const { name, sent, limit, offset } of hostileWindows(
    MAX_SESSION_PAGE_LIMIT
  )) {
    test(name, async () => {
      const { rawBinds } = registerWithRecordingPrisma();

      await registeredInvokeHandler(PR_SESSIONS_CHANNEL)(TRUSTED_EVENT, sent);

      assert.deepEqual(rawBinds(), [{ limit, offset }]);
    });
  }

  test("an absent window still binds the store's own default page", async () => {
    // `listPrSessions` destructures `{ limit = 100, offset = 0 }` and the
    // ceiling is 100, so a caller that sends nothing must see the same page it
    // saw before the clamp existed.
    const { rawBinds } = registerWithRecordingPrisma();

    await registeredInvokeHandler(PR_SESSIONS_CHANNEL)(TRUSTED_EVENT);
    await registeredInvokeHandler(PR_SESSIONS_CHANNEL)(TRUSTED_EVENT, {
      limit: "100000",
    });

    assert.deepEqual(rawBinds(), [
      { limit: MAX_SESSION_PAGE_LIMIT, offset: 0 },
      { limit: MAX_SESSION_PAGE_LIMIT, offset: 0 },
    ]);
  });
});

describe("ISS-8143 — get-pr-list clamps the renderer's page window", () => {
  for (const { name, sent, limit, offset } of hostileWindows(
    MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT
  )) {
    test(name, async () => {
      const { artifactReads } = registerWithRecordingPrisma();

      await registeredInvokeHandler(PR_LIST_CHANNEL)(TRUSTED_EVENT, sent);

      assert.equal(artifactReads().length, 1);
      assert.equal(artifactReads()[0].take, limit);
      // `findPrArtifacts` omits `skip` entirely for a falsy offset, which is
      // the same page as `skip: 0`.
      assert.equal(artifactReads()[0].skip ?? 0, offset);
    });
  }

  test("an absent window still reads the store's own default page", async () => {
    const { artifactReads } = registerWithRecordingPrisma();

    await registeredInvokeHandler(PR_LIST_CHANNEL)(TRUSTED_EVENT);
    await registeredInvokeHandler(PR_LIST_CHANNEL)(TRUSTED_EVENT, "nonsense");

    for (const args of artifactReads()) {
      assert.equal(args.take, MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT);
      assert.equal(args.skip ?? 0, 0);
    }
    assert.equal(artifactReads().length, 2);
  });

  test("the window clamp does not disturb the row filters", async () => {
    const { artifactReads } = registerWithRecordingPrisma();

    await registeredInvokeHandler(PR_LIST_CHANNEL)(TRUSTED_EVENT, {
      sessionId: "session-1",
      repo: "owner/repo",
      limit: 1e9,
    });

    // The EXACT predicates, not merely that a `where` exists: `buildPrWhere`
    // always supplies `kind`, so an existence check passes even with both
    // `repo` and `sessionId` forwarding deleted.
    const where = (artifactReads()[0] as { where?: Record<string, unknown> })
      .where;
    assert.equal(where?.repoFullName, "owner/repo");
    assert.deepEqual(where?.artifactLinks, {
      some: { sessionId: "session-1" },
    });
    assert.equal(
      artifactReads()[0].take,
      MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT
    );
  });
});
