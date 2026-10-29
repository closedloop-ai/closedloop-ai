/**
 * @file kanban-pages-ipc-coercion.test.ts
 * @description ISS-8143 — `desktop:db:get-kanban-pages` end to end, from the
 * renderer's untrusted arguments to the accumulator that keys the result by
 * them.
 *
 * The channel appeared in ZERO test files. Two things were unproven:
 *
 * 1. The SINK. `getKanbanPages` built its result on a plain `{}` and assigned
 *    `result[status]`, which FIRES the `__proto__` setter. A renderer asking
 *    for a `__proto__` column mutated the result's prototype, the column
 *    vanished from `Object.keys`, and every field of that page became an
 *    inherited property. The handler's only filter is `typeof s === "string"`,
 *    so the key reaches the sink untouched.
 * 2. The HANDLER's own numeric clamp. It is correct and two-sided already —
 *    and had no test, so deleting either side was silently green.
 *
 * The sink case drives the REAL `createSqliteSessionStore` accumulator with a
 * fake `getPage`, so the assertion lands on the line under test rather than on
 * a database. The handler and the accumulator are exercised separately, so a
 * third case joins them: it sends `__proto__` THROUGH the handler and asserts
 * the status still reaches the store. Without it, narrowing the handler's
 * `typeof s === "string"` filter to also drop `__proto__` would leave every
 * other case here green — the accumulator cases call the store directly, and no
 * handler case would send that status.
 */

import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { createSqliteSessionStore } from "../src/main/database/read-stores.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import type { SessionPage } from "../src/shared/agent-db-contract.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

const KANBAN_CHANNEL = "desktop:db:get-kanban-pages";
/**
 * As a computed key, so the assertions below read the OWN property rather than
 * tripping Biome's deprecated-`__proto__`-syntax rule (which is about the
 * accessor, not about a map key that happens to spell the same word — and that
 * collision is the entire bug).
 */
const PROTO_KEY = "__proto__";
const TRUSTED_EVENT = { sender: {} };
/** The handler's fallback when `limit` is not an integer. */
const DEFAULT_KANBAN_LIMIT = 25;
/** The handler's upper clamp. */
const MAX_KANBAN_LIMIT = 100;

let mock: ElectronModuleMock;
let registerLocalDashboardReadIpcHandlers: (deps: { withDb: WithDb }) => void;

beforeAll(async () => {
  mock = registerElectronModuleMock();
  const local = await import(
    "../src/main/dashboard/agent-dashboard-local-read-ipc.js"
  );
  registerLocalDashboardReadIpcHandlers =
    local.registerLocalDashboardReadIpcHandlers as typeof registerLocalDashboardReadIpcHandlers;
});

afterAll(() => {
  mock.deregister();
});

afterEach(() => {
  resetElectronModuleStub();
});

/** The `(statuses, limit)` pair one `getKanbanPages` call was handed. */
type KanbanCall = { statuses: unknown; limit: unknown };

function registerWithRecordingStore(): { calls: () => KanbanCall[] } {
  const calls: KanbanCall[] = [];
  const agentDatabase = {
    sessions: {
      getKanbanPages: (statuses: unknown, limit: unknown) => {
        calls.push({ statuses, limit });
        return Promise.resolve({});
      },
    },
  } as unknown as DbHostAgentDatabase;
  const withDb: WithDb =
    (handler) =>
    async (_event, ...args) =>
      await handler(agentDatabase, ...args);

  registerLocalDashboardReadIpcHandlers({ withDb });
  return { calls: () => calls };
}

/**
 * The REAL accumulator with a stand-in page reader. `getKanbanPages` reads
 * `this.getPage`, so spreading the real store and overriding that one method
 * runs the production loop — the line that used to fire the `__proto__` setter
 * — without a database behind it.
 */
function realKanbanAccumulator(): (
  statuses: string[],
  limit: number
) => Promise<Record<string, SessionPage>> {
  const page = (limit: number, status?: string): SessionPage =>
    ({
      sessions: [],
      total: 0,
      limit,
      offset: 0,
      status,
    }) as unknown as SessionPage;
  const realStore = createSqliteSessionStore({} as unknown as DesktopPrisma);
  const store = {
    ...realStore,
    getPage: ({ limit, status }: { limit: number; status?: string }) =>
      Promise.resolve(page(limit, status)),
  };
  return (statuses, limit) => store.getKanbanPages(statuses, limit);
}

describe("ISS-8143 — a prototype-polluting status keeps its own column", () => {
  // `constructor` and `prototype` ride along because they are the other keys a
  // plain-object accumulator treats specially; only `__proto__` actually had
  // the setter, but a fix that special-cased one name and not the family would
  // pass a `__proto__`-only test.
  for (const status of ["__proto__", "constructor", "prototype"]) {
    test(`"${status}" is an OWN property of the result`, async () => {
      const getKanbanPages = realKanbanAccumulator();

      const result = await getKanbanPages([status], 25);

      assert.ok(
        Object.hasOwn(result, status),
        `"${status}" must be an own property, not swallowed by the prototype`
      );
      assert.deepEqual(Object.keys(result), [status]);
      assert.equal(result[status].limit, 25);
    });
  }

  test("a __proto__ column does not mutate the result's prototype", async () => {
    // The precise old failure: `result["__proto__"] = page` on a plain object
    // REPLACED the prototype instead of adding a key, so the caller got an
    // empty-looking object whose page fields were all inherited.
    const getKanbanPages = realKanbanAccumulator();

    const result = await getKanbanPages(["__proto__"], 25);

    assert.equal(
      Object.getPrototypeOf(result),
      null,
      "the accumulator must be null-prototype, so no assignment can hit a setter"
    );
    assert.equal(
      (result as { sessions?: unknown }).sessions,
      undefined,
      "the page's own fields must not have leaked onto the result itself"
    );
  });

  test("the column survives a structured clone as an OWN key", async () => {
    // The claim the fix's comment makes, pinned. Every result crosses at least
    // one structured-clone boundary before a renderer sees it (the db-host hop,
    // then the IPC hop), and cloning does NOT preserve a null prototype — it
    // builds an ordinary object. What matters is that deserialization uses
    // DefineOwnProperty rather than assignment, so `__proto__` re-materializes
    // as an own data property instead of firing the setter a second time. If
    // that were false the sink fix would be undone in transit and the column
    // would still vanish on the way to the kanban.
    const getKanbanPages = realKanbanAccumulator();

    const cloned = structuredClone(await getKanbanPages(["__proto__"], 25));

    assert.ok(Object.hasOwn(cloned, PROTO_KEY));
    assert.deepEqual(Object.keys(cloned), [PROTO_KEY]);
    assert.equal(
      (cloned as Record<string, SessionPage>)[PROTO_KEY].limit,
      25,
      "the page must arrive intact, not as a mutated prototype"
    );
  });

  test("ordinary statuses are unaffected", async () => {
    const getKanbanPages = realKanbanAccumulator();

    const result = await getKanbanPages(["running", "waiting"], 10);

    assert.deepEqual(Object.keys(result), ["running", "waiting"]);
    assert.equal(result.running.limit, 10);
  });
});

describe("ISS-8143 — get-kanban-pages coerces its renderer arguments", () => {
  test("a __proto__ status passes the filter and reaches the store", async () => {
    // The seam between the two blocks above. The handler must NOT special-case
    // the key away — dropping it here is the same user-visible outcome as the
    // bug (a requested column that never comes back), just moved one layer up.
    const { calls } = registerWithRecordingStore();

    await registeredInvokeHandler(KANBAN_CHANNEL)(
      TRUSTED_EVENT,
      [PROTO_KEY, "running"],
      25
    );

    assert.deepEqual(calls()[0].statuses, [PROTO_KEY, "running"]);
  });

  test("non-string statuses are dropped and a non-array becomes empty", async () => {
    const { calls } = registerWithRecordingStore();

    await registeredInvokeHandler(KANBAN_CHANNEL)(
      TRUSTED_EVENT,
      ["running", 42, null, "waiting", { status: "x" }],
      25
    );
    await registeredInvokeHandler(KANBAN_CHANNEL)(TRUSTED_EVENT, "running", 25);

    assert.deepEqual(calls()[0].statuses, ["running", "waiting"]);
    assert.deepEqual(calls()[1].statuses, []);
  });

  // The clamp that was correct but unasserted. Each row fails if either side of
  // `Math.min(Math.max(limit, 1), 100)` or the `Number.isInteger` gate is
  // deleted.
  for (const { name, sent, expected } of [
    { name: "an oversized limit caps", sent: 1e9, expected: MAX_KANBAN_LIMIT },
    { name: "a negative limit floors at 1", sent: -1, expected: 1 },
    { name: "zero floors at 1", sent: 0, expected: 1 },
    {
      name: "a fractional limit falls back to the default",
      sent: 1.5,
      expected: DEFAULT_KANBAN_LIMIT,
    },
    {
      name: "a non-number falls back to the default",
      sent: "50",
      expected: DEFAULT_KANBAN_LIMIT,
    },
    {
      name: "an absent limit falls back to the default",
      sent: undefined,
      expected: DEFAULT_KANBAN_LIMIT,
    },
    { name: "a legitimate limit passes through", sent: 40, expected: 40 },
  ]) {
    test(name, async () => {
      const { calls } = registerWithRecordingStore();

      await registeredInvokeHandler(KANBAN_CHANNEL)(
        TRUSTED_EVENT,
        ["running"],
        sent
      );

      assert.equal(calls()[0].limit, expected);
    });
  }
});
