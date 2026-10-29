import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { Harness } from "../src/main/collectors/types.js";
import { computeSyncedChildRowFingerprint } from "../src/main/database/synced-child-row-fingerprint.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makeSession } from "./normalized-session-test-utils.js";

test("child-row fingerprints retain malformed evidence and hash valid siblings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "child-row-json-guard-"));
  const db = await openTestDb(dir);
  try {
    const sessionId = "child-row-json-guard";
    await db.importer.importSession(
      makeSession({
        sessionId,
        entrypoint: Harness.Claude,
        artifacts: {
          prs: [],
          issues: [],
          repo: "closedloop-ai/closedloop-ai",
        },
        toolUses: [
          {
            name: "Bash",
            timestamp: "2026-06-07T12:01:00.000Z",
            input: { command: "gh pr review 4242 --approve" },
          },
          {
            name: "Bash",
            timestamp: "2026-06-07T12:01:01.000Z",
            input: { command: "gh pr review 4243 --approve" },
          },
        ],
      }),
      Harness.Claude
    );
    const links = await db.prisma.client.$queryRawUnsafe<
      { id: string; evidence: string }[]
    >(
      "SELECT id, evidence FROM session_artifact_links WHERE session_id = $1 ORDER BY id",
      sessionId
    );
    assert.equal(links.length, 2);
    const malformedEvidence = "{malformed-json";
    await db.run(
      "UPDATE session_artifact_links SET evidence = $1 WHERE id = $2",
      malformedEvidence,
      links[0]?.id
    );

    const digest = await computeSyncedChildRowFingerprint(
      db.prisma.client,
      sessionId,
      true
    );
    const legacy = await computeSyncedChildRowFingerprint(
      db.prisma.client,
      sessionId,
      false
    );

    assert.ok(digest.length > 0);
    assert.ok(legacy.length > 0);
    const retained = await db.prisma.client.$queryRawUnsafe<
      { id: string; evidence: string }[]
    >(
      "SELECT id, evidence FROM session_artifact_links WHERE session_id = $1 ORDER BY id",
      sessionId
    );
    assert.equal(retained[0]?.evidence, malformedEvidence);
    assert.doesNotThrow(() => JSON.parse(retained[1]?.evidence ?? ""));
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
