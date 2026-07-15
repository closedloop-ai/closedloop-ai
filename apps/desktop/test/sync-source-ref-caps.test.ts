/**
 * @file sync-source-ref-caps.test.ts
 * @description FEA-2711 — the desktop sync source must bound each session's
 * `artifactRefs` / `prRefs` — AND the legacy `prs` field derived from the same
 * PR rows — to the same per-session caps the cloud wire schema enforces
 * (`MAX_SYNCED_ARTIFACT_REFS` / `MAX_SYNCED_SESSION_PR_REFS`).
 *
 * Without the cap, a session that accumulated more than 100 artifact-links (or
 * PR-links) syncs an oversized array. The cloud validates the whole batch (up
 * to 200 sessions) with a single parse, so one oversized session would reject
 * the ENTIRE batch and silently stall sync — not just truncate that session.
 * The cloud schema also validates the legacy `prs` field with `.max(...)`, so a
 * capped `prRefs` alone is not enough: the same PR rows flow into
 * `buildSessionTraceSyncFields` and emit `prs`, which must be capped too. This
 * test drives the real SQLite → `loadSyncedSessions` boundary to prove all
 * three arrays are sliced to the cap before they leave the desktop.
 *
 * T-10.9 — also verifies that `components[]` in a loaded session is sliced
 * to the MAX_SESSION_COMPONENT_USAGE cap (500) before the payload leaves the
 * desktop.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_SYNCED_ARTIFACT_REFS,
  MAX_SYNCED_SESSION_PR_REFS,
} from "@repo/api/src/types/session-artifact-link";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

// A session cwd of NULL short-circuits attribution resolution, so empty maps
// suffice — these assertions are about ref-array bounds, not attribution.
function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

const OVERSIZED = 150; // comfortably past the 100 cap for both arrays

/**
 * Seed one session with more links than either cap allows:
 *   - OVERSIZED `closedloop_artifact` links (each → one `artifactRefs` entry)
 *   - OVERSIZED `pull_request` links (each → one `prRefs` entry)
 */
async function seedOversizedSession(db: {
  run(sql: string, ...params: unknown[]): Promise<void>;
}): Promise<void> {
  await db.run("INSERT INTO sessions (id, status) VALUES ('busy','completed')");

  for (let i = 0; i < OVERSIZED; i++) {
    // A closedloop artifact ref: kind + slug drive the `artifactRefs` branch.
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, slug, created_at, last_seen_at)
       VALUES (?, ?, 'closedloop_artifact', ?, 't1', 't1')`,
      `art-cl-${i}`,
      `closedloop_artifact:${i}`,
      `PRD-${i}`
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
       VALUES (?, 'busy', ?, 'created', 'url_match', '{}', 1, 't1', ?)`,
      `l-cl-${i}`,
      `art-cl-${i}`,
      // created_at drives the ORDER BY the slice keeps; zero-pad for stable order.
      `t-cl-${String(i).padStart(4, "0")}`
    );

    // A pull_request ref: repo_full_name + pr_number + url drive `prRefs`.
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, pr_number, url, created_at, last_seen_at)
       VALUES (?, ?, 'pull_request', 'acme/repo', ?, ?, 't1', 't1')`,
      `art-pr-${i}`,
      `pull_request:${i}`,
      i + 1,
      `https://github.com/acme/repo/pull/${i + 1}`
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
       VALUES (?, 'busy', ?, 'created', 'url_match', '{}', 1, 't1', ?)`,
      `l-pr-${i}`,
      `art-pr-${i}`,
      `t-pr-${String(i).padStart(4, "0")}`
    );
  }
}

// ---------------------------------------------------------------------------
// T-10.9 — components[] cap (MAX_SESSION_COMPONENT_USAGE = 500)
// ---------------------------------------------------------------------------

const MAX_SESSION_COMPONENT_USAGE = 500; // mirrors the private constant in sync-source.ts
const OVERSIZED_COMPONENTS = 600; // comfortably past the 500 cap

test("T-10.9: oversized components[] is sliced to MAX_SESSION_COMPONENT_USAGE (500)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "t109-comp-caps-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      // Seed a single session and flood it with usage rows beyond the cap.
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('comp-sess','completed')"
      );
      for (let i = 0; i < OVERSIZED_COMPONENTS; i++) {
        // component_key is unique per row (PK is session_id + kind + key).
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, 1, 0)`,
          `tool-${String(i).padStart(4, "0")}`
        );
      }

      const [session] = await db.syncSource.loadSyncedSessions(
        ["comp-sess"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.ok(
        Array.isArray(session.components),
        "components[] must be present for an oversized session"
      );
      assert.equal(
        session.components?.length,
        MAX_SESSION_COMPONENT_USAGE,
        "components[] sliced to the shared cap (500)"
      );

      // The slice keeps the earliest rows (alphabetically by component_key)
      // since the query orders by component_kind ASC, component_key ASC.
      const firstKey = session.components?.[0]?.componentKey;
      assert.equal(firstKey, "tool-0000", "earliest component_key is retained");
      const lastKey =
        session.components?.[MAX_SESSION_COMPONENT_USAGE - 1]?.componentKey;
      assert.equal(
        lastKey,
        `tool-${String(MAX_SESSION_COMPONENT_USAGE - 1).padStart(4, "0")}`,
        "last retained key is at the cap boundary"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3029: the component cap never splits a (kind,key) branch group", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3029-comp-groups-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('comp-sess','completed')"
      );
      // A leading multi-branch group that fits under the cap: its 3 branch rows
      // must survive whole.
      const FITTING_GROUP_KEY = "tool-0000";
      const FITTING_GROUP_BRANCHES = 3;
      for (let b = 0; b < FITTING_GROUP_BRANCHES; b++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, git_branch, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, ?, 1, 0)`,
          FITTING_GROUP_KEY,
          `feat/branch-${b}`
        );
      }
      // Fill exactly up to the cap with single-branch groups, so the next group
      // straddles the MAX_SESSION_COMPONENT_USAGE boundary.
      const SINGLE_GROUPS =
        MAX_SESSION_COMPONENT_USAGE - FITTING_GROUP_BRANCHES;
      for (let i = 1; i <= SINGLE_GROUPS; i++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, 1, 0)`,
          `tool-${String(i).padStart(4, "0")}`
        );
      }
      // The straddling group: its branch rows would be split by a blind
      // slice(0, cap). It must be dropped whole, never partially emitted.
      const STRADDLE_GROUP_KEY = `tool-${String(SINGLE_GROUPS + 1).padStart(4, "0")}`;
      const STRADDLE_GROUP_BRANCHES = 4;
      for (let b = 0; b < STRADDLE_GROUP_BRANCHES; b++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, git_branch, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, ?, 1, 0)`,
          STRADDLE_GROUP_KEY,
          `feat/straddle-${b}`
        );
      }

      const [session] = await db.syncSource.loadSyncedSessions(
        ["comp-sess"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const components = session.components ?? [];
      assert.ok(
        components.length <= MAX_SESSION_COMPONENT_USAGE,
        "components[] stays within the shared cap"
      );

      // Tally emitted branch rows per (kind,key) group.
      const emittedByKey = new Map<string, number>();
      for (const usage of components) {
        emittedByKey.set(
          usage.componentKey,
          (emittedByKey.get(usage.componentKey) ?? 0) + 1
        );
      }

      // The fitting leading group survives with all of its branches.
      assert.equal(
        emittedByKey.get(FITTING_GROUP_KEY),
        FITTING_GROUP_BRANCHES,
        "a multi-branch group under the cap is kept whole"
      );
      // The straddling group is dropped whole — never a partial branch set that
      // the cloud prune would treat as authoritative.
      assert.equal(
        emittedByKey.get(STRADDLE_GROUP_KEY),
        undefined,
        "the boundary-straddling group is dropped whole, not split"
      );
      // No group is emitted with fewer branches than the DB holds for it: every
      // group is all-or-nothing. Here every emitted group has exactly its full
      // branch count (3 for the fitting group, 1 for the single-branch groups).
      for (const [key, count] of emittedByKey) {
        const expected = key === FITTING_GROUP_KEY ? FITTING_GROUP_BRANCHES : 1;
        assert.equal(
          count,
          expected,
          `group ${key} is emitted with its full branch set (no partial group)`
        );
      }
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3029: a single group larger than the cap is dropped whole, never emitted oversized", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3029-comp-oversize-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('comp-sess','completed')"
      );
      // One (kind,key) group whose branch rows alone exceed the cap. It cannot
      // be sent whole without overflowing the cloud's max-500 array validation
      // (which rejects the entire batch), so it must be dropped entirely — the
      // `components` key is omitted rather than sliced into a partial group.
      const OVERSIZED_GROUP_BRANCHES = MAX_SESSION_COMPONENT_USAGE + 10;
      for (let b = 0; b < OVERSIZED_GROUP_BRANCHES; b++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, git_branch, invocations, error_count)
           VALUES ('comp-sess', 'tool', 'tool-solo', ?, 1, 0)`,
          `feat/branch-${String(b).padStart(4, "0")}`
        );
      }

      const [session] = await db.syncSource.loadSyncedSessions(
        ["comp-sess"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      // Omitted entirely (undefined), never an oversized or partial array.
      assert.equal(
        session.components,
        undefined,
        "an over-cap single group omits components rather than emitting a partial/oversized array"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3029: an over-cap group does not starve later groups that still fit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3029-comp-skip-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('comp-sess','completed')"
      );
      // A leading group whose branch rows alone exceed the cap. It sorts first
      // (component_key ASC), so a `break` on the first over-budget group would
      // drop the whole payload and permanently starve the small group after it.
      const OVER_CAP_KEY = "tool-aaa";
      const OVER_CAP_BRANCHES = MAX_SESSION_COMPONENT_USAGE + 10;
      for (let b = 0; b < OVER_CAP_BRANCHES; b++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, git_branch, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, ?, 1, 0)`,
          OVER_CAP_KEY,
          `feat/branch-${String(b).padStart(4, "0")}`
        );
      }
      // A tiny group ordered after the over-cap one. It comfortably fits within
      // the (still-empty) budget and must be synced, not starved.
      const FITTING_KEY = "tool-bbb";
      await db.run(
        `INSERT INTO agent_component_session_usage
           (session_id, component_kind, component_key, invocations, error_count)
         VALUES ('comp-sess', 'tool', ?, 1, 0)`,
        FITTING_KEY
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["comp-sess"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const components = session.components ?? [];
      const emittedKeys = new Set(
        components.map((usage) => usage.componentKey)
      );
      // The over-cap group is dropped whole, never emitted oversized/partial.
      assert.ok(
        !emittedKeys.has(OVER_CAP_KEY),
        "the over-cap group is dropped whole"
      );
      // The small later group survives — it is not starved by the earlier drop.
      assert.ok(
        emittedKeys.has(FITTING_KEY),
        "a later group that fits is synced even after an earlier over-cap group"
      );
      assert.ok(
        components.length <= MAX_SESSION_COMPONENT_USAGE,
        "components[] stays within the shared cap"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2711: oversized artifactRefs/prRefs are sliced to the shared caps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2711-ref-caps-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await seedOversizedSession(db);

      const [session] = await db.syncSource.loadSyncedSessions(
        ["busy"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");

      assert.equal(
        session.artifactRefs?.length,
        MAX_SYNCED_ARTIFACT_REFS,
        "artifactRefs sliced to the shared cap"
      );
      assert.equal(
        session.prRefs.length,
        MAX_SYNCED_SESSION_PR_REFS,
        "prRefs sliced to the shared cap"
      );
      // The legacy `prs` field is derived from the SAME PR rows via
      // buildSessionTraceSyncFields; capping only prRefs would still ship an
      // oversized `prs` and fail the cloud's `prs.max(...)` validation.
      assert.equal(
        session.prs?.length,
        MAX_SYNCED_SESSION_PR_REFS,
        "legacy prs field sliced to the same shared cap"
      );

      // Links are ordered oldest-first, so the slice keeps the earliest N.
      const first = session.artifactRefs?.[0];
      assert.ok(first, "artifactRefs is non-empty");
      if (first.kind === "closedloop_artifact") {
        assert.equal(
          first.slug,
          "PRD-0",
          "artifactRefs keeps the earliest links"
        );
      } else {
        assert.fail(`unexpected first ref kind: ${first.kind}`);
      }

      // `prs` rows are ordered by pr_number ascending, so the cap keeps the
      // earliest PRs (#1..#100) and drops the tail (#101..#150).
      const prNums = new Set(session.prs?.map((pr) => pr.num));
      assert.ok(prNums.has(1), "prs keeps the earliest PR (#1)");
      assert.ok(
        !prNums.has(OVERSIZED),
        "prs drops the newest PR beyond the cap"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
