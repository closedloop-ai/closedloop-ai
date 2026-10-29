/**
 * The DESKTOP half of the Sessions list parity harness (ISS-9584, ISS-9483):
 * seeding a scenario's rows into a real SQLite store, writing to them, and
 * reading the list through each entry production serves it from. The runners
 * are `test/session-list-parity*.test.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  type ListQueryRefusal,
} from "@repo/api/src/types/list-query-expression.js";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link.js";
import type { SessionListParityWrite } from "@repo/lib/sessions/__tests__/session-list-parity-concurrency.js";
import {
  bindParityOwners,
  SESSION_LIST_PARITY_HEADLESS_AUTONOMY,
  SESSION_LIST_PARITY_OWNER_NAMES,
  type SessionListParityCase,
  SessionListParityOwner,
  SessionListParityPullRequest,
  type SessionListParityRead,
  type SessionListParityRow,
} from "@repo/lib/sessions/__tests__/session-list-parity-model.js";
import { z } from "zod";
import { coerceSharedAgentSessionsListRequest } from "../../src/main/dashboard/agent-dashboard-ipc-coercion.js";
import { createDbIpcHandlerWrappers } from "../../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../../src/main/dashboard/agent-dashboard-runtime-options.js";
import { SessionListQueryRefusedError } from "../../src/main/session/session-list-query-compiler.js";
import { getSharedAgentSessions } from "../../src/main/session/shared-agent-sessions-api.js";
import {
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
  type SharedAgentSessionsListRequest,
} from "../../src/shared/shared-agent-sessions-contract.js";
import { openTestDb } from "../agent-db-test-utils.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "../helpers/electron-module-mock.js";
import {
  type IpcMainInvokeHandler,
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "../helpers/electron-module-stub.js";
import {
  insertSqliteEvent,
  insertSqlitePrArtifact,
} from "../sqlite-session-fixtures.js";

export type ParityTestDb = Awaited<ReturnType<typeof openTestDb>>;

export const PARITY_OWNER_IDS = {
  [SessionListParityOwner.A]: "parity-owner-a",
  [SessionListParityOwner.B]: "parity-owner-b",
} as const;

/** The org-directory identity every parity read warms owners under. */
export const PARITY_API_ORIGIN = "https://api.parity.test";
export const PARITY_API_KEY = "sk_live_parity";

/** Absent from disk, so the repository resolves from the stored name alone. */
const ABSENT_CWD = "/iss-9584/absent-worktree";
/**
 * A launch the desktop reads as headless, which with agent activity scores
 * autonomy at {@link SESSION_LIST_PARITY_HEADLESS_AUTONOMY}.
 */
const HEADLESS_ENTRYPOINT = "sdk-cli";
const PR_NUMBER = 9584;
const TRUSTED_EVENT = { sender: {} };

/**
 * The runtime options the registered `pageData` handler reads. The handler
 * warms the org directory itself, so it gets the identity the runners warmed
 * it under; any other identity would clear the owners. No compute target or
 * dead-letter reader, as on a store that has not synced.
 */
const PAGE_DATA_RUNTIME_OPTIONS: AgentDashboardDesignSystemRuntimeOptions = {
  getWindow: () => null,
  isTrustedSender: () => true,
  onTerminalFailure: () => undefined,
  setAgentMonitorRuntimeStatus: () => undefined,
  getApiOrigin: () => PARITY_API_ORIGIN,
  getApiKey: () => PARITY_API_KEY,
};

const pageDataListSchema = z.object({
  list: z.object({
    items: z.array(z.object({ id: z.string() })),
    total: z.number(),
  }),
});

type PageDataChannel = {
  mock: ElectronModuleMock;
  handler: IpcMainInvokeHandler;
};

const openStores: { db: ParityTestDb; dir: string }[] = [];
let pageDataChannel: Promise<PageDataChannel> | undefined;
/** The store the registered handler reads; reads in a file run one at a time. */
let pageDataStore: ParityTestDb | undefined;

/** A fresh store holding `rows`. Closed by {@link closeParityHost}. */
export async function openParityStore(
  rows: readonly SessionListParityRow[]
): Promise<ParityTestDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-9584-parity-"));
  const db = await openTestDb(dir);
  openStores.push({ db, dir });
  for (const row of rows) {
    await seedParityRow(db, row);
  }
  return db;
}

/** Close every store and deregister the `pageData` channel. */
export async function closeParityHost(): Promise<void> {
  const channel = await pageDataChannel;
  pageDataChannel = undefined;
  pageDataStore = undefined;
  if (channel) {
    resetElectronModuleStub();
    channel.mock.deregister();
  }
  for (const { db, dir } of openStores.splice(0)) {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The list read `getSharedAgentSessions` serves, the renderer's list entry. */
export async function readParityList(
  db: ParityTestDb,
  request: SharedAgentSessionsListRequest
): Promise<SessionListParityRead> {
  const response = await getSharedAgentSessions(db.syncSource, request);
  return { keys: response.items.map((item) => item.id), total: response.total };
}

/**
 * The read the Sessions page takes its rows from: the payload sent to the
 * REAL registered `pageData` IPC handler (`agent-dashboard-shared-read-ipc.ts`),
 * whose list half is the DB-host projection rather than the plain list read.
 */
export async function readParityPageData(
  db: ParityTestDb,
  payload: unknown
): Promise<SessionListParityRead> {
  return pageDataReadOf(await readParityPageDataResponse(db, payload));
}

/**
 * Apply one parity write the way ingest lands it: new activity as an event,
 * which recomputes `last_activity_at`, and the row's own columns.
 */
export async function applyParityWrite(
  db: ParityTestDb,
  write: SessionListParityWrite
): Promise<void> {
  if (write.lastActivityAt !== undefined) {
    await insertSqliteEvent(db, write.key, write.lastActivityAt);
  }
  if (write.status !== undefined) {
    await db.run(
      "UPDATE sessions SET status = $1 WHERE id = $2",
      write.status,
      write.key
    );
  }
  if (write.endedAt !== undefined) {
    await db.run(
      "UPDATE sessions SET ended_at = $1 WHERE id = $2",
      write.endedAt,
      write.key
    );
  }
  await db.run(
    "UPDATE sessions SET updated_at = $1 WHERE id = $2",
    write.updatedAt,
    write.key
  );
}

/** The org directory the owner attribution reads, both owners resolved. */
export function parityOrgDirectoryResponse(): Promise<Response> {
  const users = Object.values(SessionListParityOwner).map((owner) => ({
    id: PARITY_OWNER_IDS[owner],
    email: `${owner}@parity.test`,
    ...SESSION_LIST_PARITY_OWNER_NAMES[owner],
    avatarUrl: null,
  }));
  return Promise.resolve(
    new Response(JSON.stringify({ success: true, data: users }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
}

async function seedParityRow(
  db: ParityTestDb,
  row: SessionListParityRow
): Promise<void> {
  // Billing mode is stated: a null one is re-detected against this machine.
  await db.run(
    `INSERT INTO sessions
       (id, name, status, harness, model, cwd, repo_full_name, user_id,
        priority, billing_mode, cost_usd_estimated, metadata, started_at,
        updated_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'api', $10, $11, $12, $13, $14)`,
    row.key,
    `Parity ${row.key}`,
    row.status,
    row.harness,
    row.model,
    ABSENT_CWD,
    row.repositoryFullName,
    PARITY_OWNER_IDS[row.owner],
    row.priority,
    row.sessionTotalCostUsd ?? null,
    JSON.stringify(sessionMetadata(row)),
    row.startedAt,
    row.updatedAt,
    row.endedAt
  );
  if (row.costUsd !== null) {
    // No tokens: a token count would make the row substantive, which only
    // `turns` decides in the fixture.
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, 0, 0, 0, 0, $3)`,
      row.key,
      row.model ?? "unknown",
      row.costUsd
    );
  }
  if (row.pullRequest !== SessionListParityPullRequest.None) {
    await insertSqlitePrArtifact(db, row.key, {
      repoFullName: row.repositoryFullName,
      prNumber: PR_NUMBER,
      relation:
        row.pullRequest === SessionListParityPullRequest.Linked
          ? ArtifactRefRelation.Workspace
          : ArtifactRefRelation.Created,
    });
  }
  // The hydrated tier reads last activity from events; the SQL tier reads the
  // column the production recompute derives from them.
  await insertSqliteEvent(db, row.key, row.lastActivityAt);
}

function sessionMetadata(row: SessionListParityRow): Record<string, unknown> {
  return {
    ...(row.turns > 0 ? { userMessages: row.turns } : {}),
    ...(row.linesAdded > 0
      ? { diffStats: { linesAdded: row.linesAdded } }
      : {}),
    ...(row.autonomy === SESSION_LIST_PARITY_HEADLESS_AUTONOMY
      ? { entrypoint: HEADLESS_ENTRYPOINT }
      : {}),
  };
}

/**
 * One IPC payload read through both entries the desktop serves the list from:
 * the list read, after the coercion main applies, and the Sessions page's
 * `pageData` handler, which coerces it itself.
 */
export async function readParityEntries(
  db: ParityTestDb,
  payload: unknown
): Promise<{ list: SessionListParityRead; pageData: SessionListParityRead }> {
  return {
    list: await readParityList(
      db,
      coerceSharedAgentSessionsListRequest(payload)
    ),
    pageData: await readParityPageData(db, payload),
  };
}

/** What the registered `pageData` handler answers `payload` with, over `db`. */
export async function readParityPageDataResponse(
  db: ParityTestDb,
  payload: unknown
): Promise<unknown> {
  pageDataChannel ??= openPageDataChannel();
  const { handler } = await pageDataChannel;
  pageDataStore = db;
  return await handler(TRUSTED_EVENT, payload);
}

/**
 * Register the real Sessions and Branches read channels under the recording
 * Electron stub, the way `session-list-query-ipc-wiring.test.ts` drives them.
 * The registrar imports `electron`, so it loads after the mock is in place.
 */
async function openPageDataChannel(): Promise<PageDataChannel> {
  const mock = registerElectronModuleMock();
  const { registerSharedSessionAndBranchIpcHandlers } = await import(
    "../../src/main/dashboard/agent-dashboard-shared-read-ipc.js"
  );
  const { withDb } = createDbIpcHandlerWrappers({
    getAgentDatabase: () => {
      if (!pageDataStore) {
        return Promise.reject(new Error("no parity store is being read"));
      }
      return Promise.resolve(pageDataStore);
    },
    options: PAGE_DATA_RUNTIME_OPTIONS,
  });
  registerSharedSessionAndBranchIpcHandlers({
    withDb,
    options: PAGE_DATA_RUNTIME_OPTIONS,
    invokeStoreOp: () =>
      Promise.reject(new Error("the Sessions reads invoke no store op")),
    cancelDbHostRead: () => undefined,
  });
  return {
    mock,
    handler: registeredInvokeHandler(
      SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData
    ),
  };
}

/** The keys and `total` of a `pageData` response's list half. */
export function pageDataReadOf(response: unknown): SessionListParityRead {
  const { list } = pageDataListSchema.parse(response);
  return { keys: list.items.map((item) => item.id), total: list.total };
}

/** A parity case as the renderer sends it over IPC. */
export function parityPayloadOf(
  parityCase: Pick<SessionListParityCase, "expression" | "page">
): Record<string, unknown> {
  return {
    [LIST_QUERY_EXPRESSION_PARAM]: bindParityOwners(
      parityCase.expression,
      PARITY_OWNER_IDS
    ),
    ...parityCase.page,
  };
}

/** The ISS-9476 code main refuses `payload` with, or null when it accepts it. */
export function parityRefusalOf(payload: unknown): ListQueryRefusal | null {
  try {
    coerceSharedAgentSessionsListRequest(payload);
    return null;
  } catch (error) {
    if (error instanceof SessionListQueryRefusedError) {
      return error.refused.code;
    }
    throw error;
  }
}
