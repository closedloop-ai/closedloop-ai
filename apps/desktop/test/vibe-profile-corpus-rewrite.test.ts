import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  VIBE_SEED_BRANCH_NAMES,
  VIBE_SEED_SESSION_TITLES,
  VIBE_SEED_SIGNED_IN_LOGIN,
} from "@repo/api/src/vibe-seed-corpus";
import { afterEach, describe, it } from "vitest";
import { rewriteStoreCorpus } from "../scripts/vibe-profile/corpus-rewrite";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const [[TITLED_ID, TITLE]] = [...VIBE_SEED_SESSION_TITLES];
const dirs: string[] = [];
const CORPUS_TOOL = "mcp__closedloop-graph__ticket_detail";
const ACME_TOOL = "mcp__acme-graph__ticket_detail";
const TOOL_SESSION_ID = "session-with-tools";

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("rewriteStoreCorpus", () => {
  it("rewrites the store's corpus text to Acme work and keeps every key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-corpus-rewrite-"));
    dirs.push(dir);
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "store"),
      detectBillingMode: () => "api",
    });
    try {
      await insertSqliteSession(db, TITLED_ID, {
        name: "closedloop-ai - aff9f567",
        cwd: "/Users/testuser2/conductor/workspaces/closedloop-ai/atlanta",
        metadata: JSON.stringify({ repo: "closedloop-ai/closedloop-ai" }),
      });
      await db.run(
        `INSERT INTO events (id, session_id, event_type, created_at, data, git_branch)
         VALUES ($1, $2, 'tool_use', '2026-08-01T10:00:00.000Z', $3, $4)`,
        "event-closedloop-1",
        TITLED_ID,
        JSON.stringify({ tool_input: { command: "gh pr view FEA-2180" } }),
        "corpus/feat/total-tokens-label"
      );

      await rewriteStoreCorpus(db);

      const session = await db.prisma.client.session.findUniqueOrThrow({
        where: { id: TITLED_ID },
        select: { name: true, cwd: true, metadata: true },
      });
      assert.deepEqual(session, {
        name: TITLE,
        cwd: `/Users/${VIBE_SEED_SIGNED_IN_LOGIN}/conductor/workspaces/acme-web/atlanta`,
        metadata: JSON.stringify({ repo: "acme-co/acme-web" }),
      });
      const events = await db.prisma.client.$queryRawUnsafe<
        { id: string; data: string; gitBranch: string }[]
      >('SELECT id, data, git_branch AS "gitBranch" FROM events');
      assert.deepEqual(events, [
        {
          id: "event-closedloop-1",
          data: JSON.stringify({
            tool_input: { command: "gh pr view ACME-2180" },
          }),
          gitBranch: VIBE_SEED_BRANCH_NAMES.get(
            "corpus/feat/total-tokens-label"
          ),
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it("names a component the way Insights names the tool, in every component table", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-corpus-rewrite-"));
    dirs.push(dir);
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "store"),
      detectBillingMode: () => "api",
    });
    try {
      await insertSqliteSession(db, TOOL_SESSION_ID, {});
      await db.run(
        `INSERT INTO agent_components (id, component_kind, external_id, component_key)
         VALUES ('component-1', 'mcp', $1, $1)`,
        CORPUS_TOOL
      );
      await db.run(
        `INSERT INTO agent_component_versions
           (id, component_kind, component_key, content_hash, content)
         VALUES ('version-1', 'mcp', $1, 'hash-1', '{}')`,
        CORPUS_TOOL
      );
      await db.run(
        `INSERT INTO agent_component_invocations
           (id, session_id, external_invocation_id, component_kind, component_key,
            relationship, sequence, anchor_kind, anchor_value, attribution_status,
            evidence_class, created_at, updated_at)
         VALUES ('invocation-1', $1, 'tool:0', 'mcp', $2, 'direct', 0, 'timestamp',
           '2026-08-01T10:00:00.000Z', 'unresolved', 'none',
           '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z')`,
        TOOL_SESSION_ID,
        CORPUS_TOOL
      );
      await db.run(
        `INSERT INTO agent_component_session_usage (session_id, component_kind, component_key)
         VALUES ($1, 'mcp', $2)`,
        TOOL_SESSION_ID,
        CORPUS_TOOL
      );

      await rewriteStoreCorpus(db);

      const components = await db.prisma.client.$queryRawUnsafe<
        { id: string; externalId: string; componentKey: string }[]
      >(
        'SELECT id, external_id AS "externalId", component_key AS "componentKey" FROM agent_components'
      );
      assert.deepEqual(components, [
        { id: "component-1", externalId: ACME_TOOL, componentKey: ACME_TOOL },
      ]);
      const versions = await db.prisma.client.$queryRawUnsafe<
        { componentKey: string }[]
      >('SELECT component_key AS "componentKey" FROM agent_component_versions');
      assert.deepEqual(versions, [{ componentKey: ACME_TOOL }]);
      for (const table of [
        "agent_component_invocations",
        "agent_component_session_usage",
      ]) {
        const rows = await db.prisma.client.$queryRawUnsafe<
          { componentKey: string }[]
        >(`SELECT component_key AS "componentKey" FROM ${table}`);
        assert.deepEqual(rows, [{ componentKey: ACME_TOOL }], table);
      }
    } finally {
      await db.close();
    }
  });
});
