import assert from "node:assert/strict";
import test from "node:test";
import {
  readBranchAnalyticsActivitySegmentRows,
  readBranchAnalyticsLifecycleEventRows,
} from "../src/main/database/branch-analytics-phase-evidence.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

test("ISS-5253: phase-evidence caps are scoped to the exact branch cohort", async () => {
  await withAcDb(async (db) => {
    const seed = seeder(db);
    const requestedBranch = await seed.branch({ branch: "feature/requested" });
    const unrelatedBranch = await seed.branch({ branch: "feature/unrelated" });
    await seed.session("requested-session");
    await seed.session("unrelated-session");
    await seed.link({
      session: "requested-session",
      artifactId: requestedBranch,
      method: "git_push",
    });
    await seed.link({
      session: "unrelated-session",
      artifactId: unrelatedBranch,
      method: "git_push",
    });
    await insertActivitySegment(db, "requested-session", "requested-segment");
    await insertActivitySegment(db, "unrelated-session", "unrelated-segment");

    const branchKeys = [
      { repoFullName: "acme/web", branchName: "feature/requested" },
    ];
    const [activity, lifecycle] = await Promise.all([
      readBranchAnalyticsActivitySegmentRows(db.prisma, branchKeys),
      readBranchAnalyticsLifecycleEventRows(db.prisma, branchKeys),
    ]);

    assert.deepEqual(
      activity.rows.map(({ sessionId }) => sessionId),
      ["requested-session"]
    );
    assert.deepEqual(
      lifecycle.rows.map(({ sessionId }) => sessionId),
      ["requested-session"]
    );
    assert.equal(activity.capped, false);
    assert.equal(lifecycle.capped, false);
  });
});

type ActivityDb = Parameters<Parameters<typeof withAcDb>[0]>[0];

async function insertActivitySegment(
  db: ActivityDb,
  sessionId: string,
  id: string
): Promise<void> {
  await db.run(
    `INSERT INTO session_activity_segments
       (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers,
        version, work_item_ref, observed_at)
     VALUES ($1, $2, 'implement', 1000, 2000, 1, '[]', 4, NULL, $3)`,
    id,
    sessionId,
    "2026-06-01T00:00:00.000Z"
  );
}
