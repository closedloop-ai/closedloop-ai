/**
 * @file shared-agent-session-events-page-ipc.test.ts
 * @description ISS-9857: the `desktop:shared-agent-sessions:events` channel,
 * driven through the PRODUCTION registrar (`registerSharedSessionAndBranchIpcHandlers`)
 * and the production `withDb` wrapper, so the claims here are about the wiring
 * the renderer actually reaches — not a handler body built beside it.
 *
 * Two sources back the channel. A RECORDING fake pins what the handler hands
 * the source (the clamped limit, the decoded cursor) and what it refuses before
 * the source is reached (a malformed cursor, an untrusted sender, a source
 * without the method). A REAL SQLite store pins the served row shape against
 * the cloud route's mapping, which is the parity the shared panel relies on.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeSessionEventCursor } from "@repo/api/src/types/agent-session-event-cursor";
import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { SESSION_EVENTS_PAGE_LIMIT_BOUNDS } from "@repo/api/src/types/agent-session-events-page";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { SessionEventPageRequest } from "../src/main/database/session-event-page-read.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { SHARED_AGENT_SESSIONS_IPC_CHANNELS } from "../src/shared/shared-agent-sessions-contract.js";
import type { IpcMainInvokeHandler } from "./helpers/electron-module-stub.js";
import {
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-main-module-stub.js");
  return { ...stub, default: stub.default };
});

const CHANNEL = SHARED_AGENT_SESSIONS_IPC_CHANNELS.events;
const SESSION_ID = "events-page-session";
/** Generous, not a hidden hang: the setup imports the production module graph. */
const SETUP_TIMEOUT_MS = 300_000;

const CANNED_PAGE: AgentSessionEventsPage = {
  events: [
    {
      externalEventId: "e-10001",
      agentExternalId: null,
      eventType: "PostToolUse",
      toolName: "Bash",
      summary: "past the prefix",
      data: { tool: "Bash" },
      createdAt: "2026-07-10T00:00:10.001Z",
    },
  ],
  nextCursor: "opaque-next",
};

/** The last row of a served prefix, as the client would mint its first cursor. */
const PREFIX_TAIL = {
  createdAt: "2026-07-10T00:00:10.000Z",
  externalEventId: "e-10000",
};

const loadSessionEventPage = vi.fn((_input: SessionEventPageRequest) =>
  Promise.resolve<AgentSessionEventsPage | null>(CANNED_PAGE)
);

type Registrar =
  typeof import("../src/main/dashboard/agent-dashboard-shared-read-ipc.js");
type Wrappers =
  typeof import("../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js");
type ElectronStub = typeof import("./helpers/electron-module-stub.js");

let registrar: Registrar;
let wrappers: Wrappers;
let stub: ElectronStub;

beforeAll(async () => {
  stub = await import("./helpers/electron-module-stub.js");
  wrappers = await import(
    "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js"
  );
  registrar = await import(
    "../src/main/dashboard/agent-dashboard-shared-read-ipc.js"
  );
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  stub.resetElectronModuleStub();
  loadSessionEventPage.mockClear();
});

/**
 * One production registration pass over `syncSource`, returning the channel's
 * registered handler. The only doubles are the trust predicate (a real
 * discriminator over sender identity) and the database it would have reached.
 */
function registerWith(
  syncSource: AgentSessionSyncSource
): IpcMainInvokeHandler {
  const agentDatabase = { syncSource } as unknown as DbHostAgentDatabase;
  registrar.registerSharedSessionAndBranchIpcHandlers({
    withDb: wrappers.createDbIpcHandlerWrappers({
      getAgentDatabase: () => Promise.resolve(agentDatabase),
      options: {
        getWindow: () => null,
        isTrustedSender: isTrustedSenderDouble,
      } as AgentDashboardDesignSystemRuntimeOptions,
    }).withDb,
    options: {
      getWindow: () => null,
      isTrustedSender: isTrustedSenderDouble,
      onTerminalFailure: () => undefined,
      setAgentMonitorRuntimeStatus: () => undefined,
    },
    invokeStoreOp: () => Promise.reject(new Error("store op unreachable")),
    cancelDbHostRead: () => undefined,
  });
  return stub.registeredInvokeHandler(CHANNEL);
}

function recordingSource(): AgentSessionSyncSource {
  return { loadSessionEventPage } as unknown as AgentSessionSyncSource;
}

describe("ISS-9857: desktop:shared-agent-sessions:events", () => {
  test("a trusted sender gets the source's page, with the limit clamped and the cursor decoded", async () => {
    const handler = registerWith(recordingSource());
    const cursor = encodeSessionEventCursor(PREFIX_TAIL);
    assert.ok(cursor);

    const page = await handler(TRUSTED_EVENT, {
      id: SESSION_ID,
      cursor,
      limit: 999_999,
    });

    assert.deepEqual(page, CANNED_PAGE);
    assert.equal(loadSessionEventPage.mock.calls.length, 1);
    // The bound reaches the SQL `LIMIT` already clamped to the SHARED ceiling,
    // so a page is the same size whichever surface served it, and the cursor
    // reaches the keyset already decoded into its two comparison keys.
    assert.deepEqual(loadSessionEventPage.mock.calls[0]?.[0], {
      sessionId: SESSION_ID,
      after: PREFIX_TAIL,
      limit: SESSION_EVENTS_PAGE_LIMIT_BOUNDS.maxLimit,
    });
  });

  test("an absent cursor and limit page from the first row at the default size", async () => {
    const handler = registerWith(recordingSource());

    await handler(TRUSTED_EVENT, { id: SESSION_ID });

    assert.deepEqual(loadSessionEventPage.mock.calls[0]?.[0], {
      sessionId: SESSION_ID,
      limit: SESSION_EVENTS_PAGE_LIMIT_BOUNDS.defaultLimit,
    });
  });

  test("an untrusted sender is refused before the source is reached", async () => {
    const handler = registerWith(recordingSource());

    await expect(
      handler(UNTRUSTED_EVENT, { id: SESSION_ID }) as Promise<unknown>
    ).rejects.toThrow(UNTRUSTED_SENDER_ERROR);

    // The discriminator: hoist the handler call above the trust check and this
    // is the assertion that fails. The positive sibling above, on the SAME spy,
    // is what makes this zero mean something.
    assert.equal(loadSessionEventPage.mock.calls.length, 0);
  });

  test("a malformed cursor answers null without reaching the source", async () => {
    const handler = registerWith(recordingSource());

    // Not base64url, and a decodable-but-partless string: both are cursors no
    // producer minted, so paging on them would start from a place nobody asked
    // for. `null` is the one fail-closed answer; the renderer's local source
    // reads it as not-found (a 404 where the cloud answers 400 — see the
    // rationale in `shared-agent-session-events-page-read.ts`).
    for (const cursor of ["not a cursor!", "bm9zZXBhcmF0b3I"]) {
      assert.equal(
        await handler(TRUSTED_EVENT, { id: SESSION_ID, cursor }),
        null
      );
    }
    assert.equal(loadSessionEventPage.mock.calls.length, 0);
  });

  test("a request with no session id answers null without reaching the source", async () => {
    const handler = registerWith(recordingSource());

    assert.equal(await handler(TRUSTED_EVENT, { id: "   " }), null);
    assert.equal(await handler(TRUSTED_EVENT, "not an object"), null);
    assert.equal(loadSessionEventPage.mock.calls.length, 0);
  });

  test("a source without the method answers null", async () => {
    const handler = registerWith({} as AgentSessionSyncSource);

    // An older or fake source keeps its shape; the renderer reads this as "no
    // continuation" and keeps the end-of-read note exactly as before.
    assert.equal(await handler(TRUSTED_EVENT, { id: SESSION_ID }), null);
  });

  test("parity: a page served off the real store carries the cloud row shape plus the desktop-only text", async () => {
    const { openSqliteAgentDatabase } = await import(
      "../src/main/database/sqlite.js"
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss9857-events-ipc-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        `INSERT INTO sessions (id, status) VALUES ('${SESSION_ID}','${SESSION_STATUS.INACTIVE}')`
      );
      await db.run(
        `INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES
          ('p1','${SESSION_ID}',NULL,'PreToolUse','Bash','run tests','{"cmd":"pnpm test"}','2026-07-10T00:00:01.000Z'),
          ('p2','${SESSION_ID}','agent-1','PostToolUse','Bash','tests passed',NULL,'2026-07-10T00:00:02.000Z'),
          ('p3','${SESSION_ID}',NULL,'UserPromptSubmit',NULL,'next','{"text":"go"}','2026-07-10T00:00:03.000Z')`
      );
      const handler = registerWith(db.syncSource);

      const page = (await handler(TRUSTED_EVENT, {
        id: SESSION_ID,
        limit: 2,
      })) as AgentSessionEventsPage;

      // The cloud route selects exactly these five columns and maps them to the
      // same names (`session-events-page-read.ts` in apps/api); the desktop adds
      // the two local-only text fields the local trace renders from.
      const cloudShape = [
        "externalEventId",
        "agentExternalId",
        "eventType",
        "toolName",
        "createdAt",
      ];
      const desktopOnly = ["summary", "data"];
      for (const event of page.events) {
        assert.deepEqual(
          Object.keys(event).sort(),
          [...cloudShape, ...desktopOnly].sort()
        );
      }
      assert.deepEqual(page.events, [
        {
          externalEventId: "p1",
          agentExternalId: null,
          eventType: "PreToolUse",
          toolName: "Bash",
          summary: "run tests",
          data: { cmd: "pnpm test" },
          createdAt: "2026-07-10T00:00:01.000Z",
        },
        {
          externalEventId: "p2",
          agentExternalId: "agent-1",
          eventType: "PostToolUse",
          toolName: "Bash",
          summary: "tests passed",
          data: null,
          createdAt: "2026-07-10T00:00:02.000Z",
        },
      ]);
      assert.equal(
        page.nextCursor,
        encodeSessionEventCursor({
          createdAt: "2026-07-10T00:00:02.000Z",
          externalEventId: "p2",
        })
      );

      // Replaying the served cursor through the same channel reaches the tail.
      const tail = (await handler(TRUSTED_EVENT, {
        id: SESSION_ID,
        cursor: page.nextCursor,
        limit: 2,
      })) as AgentSessionEventsPage;
      assert.deepEqual(
        tail.events.map((event) => event.externalEventId),
        ["p3"]
      );
      assert.equal(Object.hasOwn(tail, "nextCursor"), false);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
