/**
 * ISS-12552 (PRD-800 "Rollout"): in production the collector manager's
 * importer is the import-health wrapper. The policy a source was parsed under
 * must reach the store through it, so the session is imported, gated and
 * stamped under the worker's policy rather than the store's own.
 */
import "./support/attribution-parse-policy.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DATA_REVISION_BASE } from "../src/main/collectors/engine/data-revision.js";
import { Harness } from "../src/main/collectors/types.js";
import { effectiveParsePolicy } from "../src/main/parse-policy/effective-parse-policy.js";
import { PARSE_POLICY_BASE } from "../src/main/parse-policy/parse-policy.js";
import { createImportHealthTracker } from "../src/main/telemetry/import-health-telemetry.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NO_AUTOMATIC_TICK_MS = 2 ** 31 - 1;

test("the import-health wrapper imports under the policy the source was parsed under", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss12552-wrapper-"));
  const db = await openTestDb(dir);
  const tracker = createImportHealthTracker({
    emitImportHealth: () => undefined,
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  try {
    // The store runs the attribution policy; the worker parsed under base.
    assert.equal(effectiveParsePolicy().attributionEvidence, true);
    const importer = tracker.wrapImporter(db.importer);

    await importer.importSession(
      makeSession({ sessionId: "parsed-under-base" }),
      Harness.Claude,
      PARSE_POLICY_BASE
    );

    const row = await db.prisma.client.session.findUnique({
      where: { id: "parsed-under-base" },
      select: { dataRevision: true },
    });
    assert.equal(row?.dataRevision, DATA_REVISION_BASE);
  } finally {
    tracker.dispose();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
