/**
 * ISS-12552 (PRD-800 "Rollout"): the data revision is a pair chosen by the
 * parse policy. With the policy off a Desktop stamps the revision it stamped
 * before PRD-800, and an import stamps the revision of the policy it was
 * parsed under, so a flip re-derives every session.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  DATA_REVISION_ATTRIBUTION,
  DATA_REVISION_BASE,
  dataRevisionFor,
} from "../src/main/collectors/engine/data-revision.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { currentSessionProjectionRevision } from "../src/main/collectors/engine/session-projection-gate.js";
import { Harness } from "../src/main/collectors/types.js";
import { syncStateContractStamps } from "../src/main/database/sync-cursor-state.js";
import {
  effectiveParsePolicy,
  setEffectiveParsePolicy,
} from "../src/main/parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  PARSE_POLICY_BASE,
  readParsePolicy,
} from "../src/main/parse-policy/parse-policy.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makeSession } from "./normalized-session-test-utils.js";

afterEach(() => {
  setEffectiveParsePolicy(PARSE_POLICY_BASE);
});

describe("the data revision pair (ISS-12552)", () => {
  test("off is the base revision and on is the attribution revision", () => {
    assert.equal(dataRevisionFor(PARSE_POLICY_BASE), DATA_REVISION_BASE);
    assert.equal(
      dataRevisionFor(PARSE_POLICY_ATTRIBUTION),
      DATA_REVISION_ATTRIBUTION
    );
    assert.notEqual(DATA_REVISION_BASE, DATA_REVISION_ATTRIBUTION);
  });

  test("off stamps exactly the revision main stamps", () => {
    // The literal is DATA_REVISION on main. With the policy off a Desktop must
    // stamp what main stamps, so moving the base without main moving first
    // fails here.
    assert.equal(dataRevisionFor(PARSE_POLICY_BASE), 112);
  });

  test("a process nothing has set reads the base policy", () => {
    assert.equal(effectiveParsePolicy().attributionEvidence, false);
    assert.equal(effectiveDataRevision(), DATA_REVISION_BASE);
  });

  test("an absent or malformed wire policy reads as base", () => {
    assert.equal(readParsePolicy(undefined), PARSE_POLICY_BASE);
    assert.equal(
      readParsePolicy({ attributionEvidence: "yes" }),
      PARSE_POLICY_BASE
    );
    assert.equal(
      readParsePolicy({ attributionEvidence: true, later: 1 }),
      PARSE_POLICY_ATTRIBUTION
    );
  });

  test("the process-local revision follows the policy it is set to", () => {
    setEffectiveParsePolicy(PARSE_POLICY_ATTRIBUTION);
    assert.equal(effectiveDataRevision(), DATA_REVISION_ATTRIBUTION);
    assert.equal(
      syncStateContractStamps().dataRevision,
      DATA_REVISION_ATTRIBUTION
    );
    setEffectiveParsePolicy(PARSE_POLICY_BASE);
    assert.equal(syncStateContractStamps().dataRevision, DATA_REVISION_BASE);
  });

  test("the projection revision names the policy's data revision", () => {
    assert.notEqual(
      currentSessionProjectionRevision(PARSE_POLICY_BASE),
      currentSessionProjectionRevision(PARSE_POLICY_ATTRIBUTION)
    );
    setEffectiveParsePolicy(PARSE_POLICY_ATTRIBUTION);
    assert.equal(
      currentSessionProjectionRevision(),
      currentSessionProjectionRevision(PARSE_POLICY_ATTRIBUTION)
    );
  });

  test("an import stamps the revision of the policy it was parsed under", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss12552-revision-"));
    const db = await openTestDb(dir);
    try {
      await db.importer.importSession(
        makeSession({ sessionId: "base-session" }),
        Harness.Claude,
        PARSE_POLICY_BASE
      );
      await db.importer.importSession(
        makeSession({ sessionId: "attribution-session" }),
        Harness.Claude,
        PARSE_POLICY_ATTRIBUTION
      );
      await db.importer.importSession(
        makeSession({ sessionId: "default-session" }),
        Harness.Claude
      );
      const rows = await db.prisma.client.session.findMany({
        select: { id: true, dataRevision: true },
        orderBy: { id: "asc" },
      });
      assert.deepEqual(rows, [
        { id: "attribution-session", dataRevision: DATA_REVISION_ATTRIBUTION },
        { id: "base-session", dataRevision: DATA_REVISION_BASE },
        { id: "default-session", dataRevision: DATA_REVISION_BASE },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
