import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateSyncCandidates } from "../src/main/agent-sync/agent-session-hydration-budget.js";
import { findSqliteLocallyOversizedSessions } from "../src/main/database/sync-source-session-rows.js";
import {
  createSessionAttributionResolverCache,
  getSharedAgentSessions,
} from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

const METADATA_PROJECTION_PATTERN =
  /json_replace\(metadata, '\$\.tokenSeries', 0\)/;

test("ISS-6119: the cloud-sync hydration entry point opts into metadata projection", async () => {
  const source = createFakeSource({
    cursorRows: [cursor("sync-session")],
    sessions: { "sync-session": session({ id: "sync-session" }) },
  });

  await hydrateSyncCandidates(
    source,
    ["sync-session"],
    createSessionAttributionResolverCache()
  );

  const load = source.calls.find((call) => call.kind === "loadSyncedSessions");
  assert.equal(load?.loadOptions?.omitPreviewStrippedMetadata, true);
});

test("ISS-6119: the Sessions list entry point opts into metadata projection", async () => {
  const source = createFakeSource({
    cursorRows: [cursor("list-session")],
    sessions: { "list-session": session({ id: "list-session" }) },
  });

  await getSharedAgentSessions(source, {
    quality: "all",
    limit: 25,
    offset: 0,
    sortBy: "lastActivity",
    sortDir: "desc",
  });

  const load = source.calls.find((call) => call.kind === "loadSyncedSessions");
  assert.equal(load?.loadOptions?.omitPreviewStrippedMetadata, true);
});

test("ISS-6119: the oversized-session probe opts into metadata projection", async () => {
  const statements: string[] = [];
  const prisma = {
    read: (
      run: (reader: {
        $queryRawUnsafe: (
          sql: string,
          ...values: unknown[]
        ) => Promise<unknown[]>;
      }) => unknown
    ) =>
      run({
        $queryRawUnsafe: (sql: string) => {
          statements.push(sql);
          return Promise.resolve([]);
        },
      }),
  } as unknown as Parameters<typeof findSqliteLocallyOversizedSessions>[0];

  await findSqliteLocallyOversizedSessions(prisma, ["oversized-session"], 1);

  assert.equal(statements.length, 1);
  assert.match(statements[0], METADATA_PROJECTION_PATTERN);
});
