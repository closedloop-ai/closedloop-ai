/**
 * @file data-revision-provenance-rebuild.test.ts
 * @description Focused compatibility rebuild coverage for token provenance revisions.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

describe("token provenance data-revision rebuilds", () => {
  test("ISS-4884: revision 64 rebuilds retained malformed Claude UUID provenance", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss4884-revision-"));
    const db = await openTestDb(dir);
    const sessionId = "iss4884-malformed-uuid-rebuild";
    const source = "/fake/iss4884-malformed-uuid.jsonl";
    const tokenSeriesBase = {
      timestamp: "2026-06-07T10:00:30.000Z",
      model: "claude-sonnet-4-5",
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
    } as const;
    try {
      await db.importer.importSession(
        makeSession({
          sessionId,
          tokenSeries: [
            {
              ...tokenSeriesBase,
              sourceIdentity: {
                availability: TokenSourceIdentityAvailability.Unavailable,
                reason:
                  TokenSourceIdentityUnavailableReason.MissingSourceRecordId,
              },
            },
          ],
        }),
        "claude"
      );
      await db.run(
        "UPDATE sessions SET data_revision = 63 WHERE id = $1",
        sessionId
      );

      const rebuilt = makeSession({
        sessionId,
        tokenSeries: [
          {
            ...tokenSeriesBase,
            sourceIdentity: {
              availability: TokenSourceIdentityAvailability.Unavailable,
              reason: TokenSourceIdentityUnavailableReason.Malformed,
            },
          },
        ],
      });
      const collector = fakeCollector("claude", {
        sources: [source],
        sessions: [rebuilt],
        sessionIdForSource: () => sessionId,
      });

      const result = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      const [row] = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number; source_identity: string }[]
      >(
        `SELECT s.data_revision, te.source_identity
           FROM sessions s
           JOIN token_events te ON te.session_id = s.id
          WHERE s.id = $1`,
        sessionId
      );

      assert.equal(result.rebuilt, 1);
      assert.equal(row?.data_revision, DATA_REVISION);
      assert.deepEqual(JSON.parse(row?.source_identity ?? "null"), {
        availability: TokenSourceIdentityAvailability.Unavailable,
        reason: TokenSourceIdentityUnavailableReason.Malformed,
      });
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
