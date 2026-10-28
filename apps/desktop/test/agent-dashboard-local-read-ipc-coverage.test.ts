/**
 * @file agent-dashboard-local-read-ipc-coverage.test.ts
 * @description ISS-10514: the argument guards of the local dashboard read
 * channels, driven through the production registration pass
 * (`registerDesignSystemDbIpcHandlers`) over a real migrated SQLite store.
 *
 * Every id-taking channel has two arms: a malformed id (non-string, empty, or
 * over the length cap) answers the empty value, and a valid id forwards to the
 * store. The seeded session makes the valid arm observable — it returns real
 * rows. The malformed arm is pinned only by its return value: none of those ids
 * could match a row, so these cases do not prove the guard skips the read.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { registerDesignSystemDbIpcHandlers } from "../src/main/dashboard/agent-dashboard-db-ipc-registration.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";
import {
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
} from "./helpers/ipc-registrar.js";
import { makeSession } from "./normalized-session-test-utils.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const UNTRUSTED_SENDER_RE = /untrusted sender/;
const OVERLONG_ID = "x".repeat(10_000);

let dir: string;
let db: Db;
let sessionId: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "iss-10514-local-read-"));
  db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  for (const id of ["local-read-a", "local-read-b", "local-read-c"]) {
    await db.importer.importSession(
      makeSession({
        sessionId: id,
        toolUses: [
          {
            name: "Read",
            timestamp: "2026-01-01T00:01:00.000Z",
            input: { file_path: "/src/x.ts" },
          },
        ],
      }),
      "claude"
    );
  }
  const sessions = await db.sessions.getAll();
  sessionId = sessions[0].id;
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  resetElectronModuleStub();
});

function register(): void {
  const options: AgentDashboardDesignSystemRuntimeOptions = {
    getWindow: () => null,
    isTrustedSender: isTrustedSenderDouble,
    onTerminalFailure: () => undefined,
    setAgentMonitorRuntimeStatus: () => undefined,
  };
  registerDesignSystemDbIpcHandlers(
    () => Promise.resolve(db),
    options,
    () => Promise.resolve(undefined),
    () => undefined
  );
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(
    registeredInvokeHandler(channel)(TRUSTED_EVENT, ...args)
  );
}

describe("local dashboard read IPC through the production registration pass", () => {
  it("rejects an untrusted sender before any read", async () => {
    register();
    await expect(
      Promise.resolve(
        registeredInvokeHandler("desktop:db:get-sessions")(UNTRUSTED_EVENT)
      )
    ).rejects.toThrow(UNTRUSTED_SENDER_RE);
  });

  it("get-sessions and get-sessions-page forward to the store", async () => {
    register();
    const all = (await invoke("desktop:db:get-sessions")) as unknown[];
    expect(all).toHaveLength(3);

    const page = (await invoke("desktop:db:get-sessions-page", {
      limit: 2,
      offset: 0,
    })) as { sessions: unknown[]; limit: number };
    expect(page.sessions).toHaveLength(2);
    expect(page.limit).toBe(2);

    expect(
      await invoke("desktop:db:get-sessions-page", "not-a-request")
    ).toEqual(await db.sessions.getPage(undefined));
  });

  it("get-kanban-pages keeps string statuses and clamps the limit to [1, 100]", async () => {
    register();
    const [sample] = await db.sessions.getAll();
    const status = sample.status;

    const mixed = (await invoke(
      "desktop:db:get-kanban-pages",
      [status, 7, null],
      0
    )) as Record<string, { limit: number }>;
    expect(Object.keys(mixed)).toEqual([status]);
    expect(mixed[status].limit).toBe(1);

    const high = (await invoke(
      "desktop:db:get-kanban-pages",
      [status],
      500
    )) as Record<string, { limit: number }>;
    expect(high[status].limit).toBe(100);

    const fractional = (await invoke(
      "desktop:db:get-kanban-pages",
      [status],
      2.5
    )) as Record<string, { limit: number }>;
    expect(fractional[status].limit).toBe(25);

    const stringLimit = (await invoke(
      "desktop:db:get-kanban-pages",
      [status],
      "10"
    )) as Record<string, { limit: number }>;
    expect(stringLimit[status].limit).toBe(25);

    expect(
      await invoke("desktop:db:get-kanban-pages", "not-an-array", 10)
    ).toEqual(await db.sessions.getKanbanPages([], 10));
  });

  it("get-session and get-session-details answer undefined for a malformed id", async () => {
    register();
    for (const malformed of [42, "", OVERLONG_ID, null]) {
      expect(await invoke("desktop:db:get-session", malformed)).toBeUndefined();
      expect(
        await invoke("desktop:db:get-session-details", malformed)
      ).toBeUndefined();
    }
    const session = (await invoke("desktop:db:get-session", sessionId)) as {
      id: string;
    };
    expect(session.id).toBe(sessionId);
    const details = (await invoke(
      "desktop:db:get-session-details",
      sessionId
    )) as { id: string };
    expect(details.id).toBe(sessionId);
  });

  it("agent, event, and hierarchy reads answer [] for a malformed session id", async () => {
    register();
    for (const channel of [
      "desktop:db:get-agents",
      "desktop:db:get-events",
      "desktop:db:get-events-with-session",
      "desktop:db:get-agent-hierarchy",
    ]) {
      expect(await invoke(channel, 7)).toEqual([]);
    }

    expect(await invoke("desktop:db:get-agents", sessionId)).toEqual(
      await db.agents.getBySession(sessionId)
    );
    expect(
      await invoke("desktop:db:get-events-with-session", sessionId)
    ).toEqual(await db.events.getWithSession(sessionId));
    expect(await invoke("desktop:db:get-agent-hierarchy", sessionId)).toEqual(
      await db.agents.getBySessionWithChildren(sessionId)
    );
  });

  it("get-events narrows to an agent only when the agent id is valid", async () => {
    register();
    const bySession = await db.events.getBySession(sessionId);
    expect(bySession.length).toBeGreaterThan(0);

    expect(await invoke("desktop:db:get-events", sessionId)).toEqual(bySession);
    expect(await invoke("desktop:db:get-events", sessionId, "")).toEqual(
      bySession
    );
    expect(
      await invoke("desktop:db:get-events", sessionId, "no-such-agent")
    ).toEqual([]);
  });

  it("get-insights coerces an unknown section and period to the defaults", async () => {
    register();
    expect(
      await invoke("desktop:db:get-insights", "future-section", "decade")
    ).toEqual(
      // ISS-12256: the handler's own Delivery answer, which adds the local
      // Branch coverage chart to the store's payload.
      await invoke(
        "desktop:db:get-insights",
        InsightsSection.Delivery,
        InsightsPeriod.Quarter
      )
    );
  });
});
