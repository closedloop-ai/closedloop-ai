/**
 * ISS-5288 — what the snapshot importer does when a session's related rows
 * exceed a PER-PAYLOAD wire cap.
 *
 * Split out of `perf-import-desktop-snapshot.test.ts` (1,000-line ceiling), and
 * kept together because both caps answer the same question: this lane hands a
 * whole session to the fold in ONE payload, so it cannot paginate the way the
 * desktop producer does — and a prefix slice is the one answer that lies. Each
 * suite pins the invariant the DESKTOP enforces, because a perf corpus that
 * disagrees with real sync output measures the wrong database.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  MAX_SYNCED_ACTIVITY_SEGMENTS,
  MAX_SYNCED_COMPONENT_USAGE,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";
import { buildBatchPayload } from "../perf-import-desktop-snapshot";
import { SkipReason } from "../perf-import-desktop-snapshot-mapping";
import {
  insertSession,
  mapSnapshot,
  withSnapshot,
} from "./perf-import-snapshot-fixture";

const SESSION_ID = "cap-session";

function seedActivitySegments(db: DatabaseSync, count: number): void {
  const statement = db.prepare(
    `INSERT INTO session_activity_segments
       (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers,
        version, work_item_ref, observed_at, subagent_id)
     VALUES (?, ?, 'implement', ?, ?, 0.9, '[]', 4, NULL, NULL, NULL)`
  );
  // One transaction, not 5,000 — an implicit commit per row makes a cap-sized
  // seed take tens of seconds and the suite reads as a hang. Every seeder here
  // does this; it is the difference between milliseconds and a timeout.
  db.exec("BEGIN");
  for (let index = 0; index < count; index++) {
    statement.run(`seg-${index}`, SESSION_ID, index * 10, index * 10 + 10);
  }
  db.exec("COMMIT");
}

/**
 * `groupCount` groups of `branchesPerGroup` per-branch rows each, in the
 * `(kind, key, branch)` order the desktop's own sync-source read imposes.
 */
function seedComponentUsage(
  db: DatabaseSync,
  groupCount: number,
  branchesPerGroup: number
): void {
  const statement = db.prepare(
    `INSERT INTO agent_component_session_usage
       (session_id, component_kind, component_key, git_branch,
        agent_component_id, harness, invocations, error_count,
        first_invoked_at, last_invoked_at, started_day, component_version_hash)
     VALUES (?, 'skill', ?, ?, NULL, 'claude', 1, 0, NULL, NULL, NULL, NULL)`
  );
  db.exec("BEGIN");
  for (let group = 0; group < groupCount; group++) {
    for (let branch = 0; branch < branchesPerGroup; branch++) {
      statement.run(
        SESSION_ID,
        `key-${String(group).padStart(4, "0")}`,
        `branch-${String(branch).padStart(4, "0")}`
      );
    }
  }
  db.exec("COMMIT");
}

function componentGroupsOf(session: Record<string, unknown>): string[] {
  const components = (session.components ?? []) as { componentKey: string }[];
  return [...new Set(components.map((row) => row.componentKey))];
}

describe("activity tiling above the per-payload cap", () => {
  it("carries a tiling at exactly the cap", async () => {
    const { sessions, skips } = await withSnapshot((db) => {
      insertSession(db, { id: SESSION_ID });
      seedActivitySegments(db, MAX_SYNCED_ACTIVITY_SEGMENTS);
    }, mapSnapshot);

    expect(skips).toStrictEqual({});
    const rows = sessions[0]?.activitySegmentRows as unknown[];
    expect(rows).toHaveLength(MAX_SYNCED_ACTIVITY_SEGMENTS);
  });

  it("omits an over-cap tiling entirely rather than persisting a prefix", async () => {
    const { sessions, skips } = await withSnapshot((db) => {
      insertSession(db, { id: SESSION_ID });
      seedActivitySegments(db, MAX_SYNCED_ACTIVITY_SEGMENTS + 1);
    }, mapSnapshot);

    // ISS-4541: the desktop paginates an over-cap tiling across sync parts and
    // dead-letters rather than shipping a prefix, because the cloud cannot tell
    // a truncated tiling from a complete one. This lane cannot paginate, so the
    // only honest answer is the wire's no-claim: omit the key.
    expect(sessions[0]).not.toHaveProperty("activitySegmentRows");
    expect(skips).toStrictEqual({
      [SkipReason.ActivityTilingOverPayloadCap]: 1,
    });
  });

  it("still produces a payload the real wire schema accepts", async () => {
    const { sessions } = await withSnapshot((db) => {
      insertSession(db, { id: SESSION_ID });
      seedActivitySegments(db, MAX_SYNCED_ACTIVITY_SEGMENTS + 250);
    }, mapSnapshot);

    // Omission is the only answer that is BOTH honest and shippable: sending
    // the full tiling would fail `.max(MAX_SYNCED_ACTIVITY_SEGMENTS)` and take
    // the whole batch (up to 100 sessions) down with it.
    expect(sessions[0]).not.toHaveProperty("activitySegmentRows");
    const parsed = desktopAgentSessionsPayloadObjectSchema.safeParse(
      buildBatchPayload(sessions)
    );
    expect(parsed.success ? "" : "payload rejected by the wire schema").toBe(
      ""
    );
  });
});

describe("component usage above the per-payload cap", () => {
  it("keeps every group whole when the cap is exceeded", async () => {
    const branchesPerGroup = 7;
    const groupCount =
      Math.ceil(MAX_SYNCED_COMPONENT_USAGE / branchesPerGroup) + 3;
    const { sessions, skips } = await withSnapshot((db) => {
      insertSession(db, { id: SESSION_ID });
      seedComponentUsage(db, groupCount, branchesPerGroup);
    }, mapSnapshot);

    const components = sessions[0]?.components as { componentKey: string }[];
    expect(components.length).toBeLessThanOrEqual(MAX_SYNCED_COMPONENT_USAGE);
    // The defect a prefix slice causes: a split group makes the cloud treat the
    // surviving branches as the group's whole branch set and prune the rest.
    const perGroup = new Map<string, number>();
    for (const row of components) {
      perGroup.set(row.componentKey, (perGroup.get(row.componentKey) ?? 0) + 1);
    }
    expect([...perGroup.values()]).toStrictEqual(
      [...perGroup.values()].map(() => branchesPerGroup)
    );
    expect(skips[SkipReason.ComponentUsageGroupOverCap]).toBeGreaterThan(0);
  });

  it("lets a later small group take the budget an over-budget group left", async () => {
    // One group too large to ever fit, then small groups that do. Skipping the
    // oversized group and CONTINUING (rather than breaking) is what keeps the
    // small ones from being starved on every run.
    const { sessions, skips } = await withSnapshot((db) => {
      insertSession(db, { id: SESSION_ID });
      const statement = db.prepare(
        `INSERT INTO agent_component_session_usage
           (session_id, component_kind, component_key, git_branch,
            agent_component_id, harness, invocations, error_count,
            first_invoked_at, last_invoked_at, started_day,
            component_version_hash)
         VALUES (?, 'skill', ?, ?, NULL, 'claude', 1, 0, NULL, NULL, NULL, NULL)`
      );
      db.exec("BEGIN");
      for (let branch = 0; branch <= MAX_SYNCED_COMPONENT_USAGE; branch++) {
        statement.run(
          SESSION_ID,
          "key-0000-huge",
          `branch-${String(branch).padStart(5, "0")}`
        );
      }
      statement.run(SESSION_ID, "key-1111-small", "main");
      statement.run(SESSION_ID, "key-2222-small", "main");
      db.exec("COMMIT");
    }, mapSnapshot);

    expect(componentGroupsOf(sessions[0] ?? {})).toStrictEqual([
      "key-1111-small",
      "key-2222-small",
    ]);
    expect(skips[SkipReason.ComponentUsageGroupOverCap]).toBe(1);
  });

  it("leaves an under-cap session untouched and untallied", async () => {
    const { sessions, skips } = await withSnapshot((db) => {
      insertSession(db, { id: SESSION_ID });
      seedComponentUsage(db, 3, 4);
    }, mapSnapshot);

    expect(skips).toStrictEqual({});
    const [session] = sessions;
    expect(session).toBeDefined();
    expect((session.components as unknown[]).length).toBe(12);
  });
});
