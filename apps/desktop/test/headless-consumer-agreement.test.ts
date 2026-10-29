/**
 * @file headless-consumer-agreement.test.ts
 * @description ISS-7260 — the three consumers of the headless classification must
 * keep classifying the same session the same way, and the ONE place they are
 * deliberately allowed to differ must stay exactly that one place.
 *
 * The consumers, and what each of them actually calls:
 *  1. the write-time `is_human` rollup's PREDICATE — `headlessMetadataSql`, real
 *     SQL, run here against real SQLite rather than string-compared. The
 *     predicate, not the whole `is_human` CASE: that also carries a human-turn
 *     threshold, on an axis the bucket derivation deliberately does not share,
 *     and its arms are pinned in `session-analytics-backfill-batch.test.ts`;
 *  2. the per-turn heatmap / autonomy-trend buckets — `deriveSessionTurnBuckets`,
 *     whose headless half SUPPRESSES the human rows, so the observable is the
 *     bucket output, not the predicate. Its AGENT half is out of scope by
 *     construction — `collectAgentUnits` never consults the classifier — which is
 *     why every case below seeds an empty `tokenSeries`;
 *  3. the read-time autonomy score's input — `buildSessionAutonomyInput`, which
 *     consults the ENTRYPOINT leg ONLY (FEA-3781). That asymmetry is deliberate:
 *     `permissionMode === "bypassPermissions"` is the one signal that can assert
 *     a person's hands-on session is fully autonomous on its own, and interactive
 *     operators routinely run with permissions skipped.
 *
 * The cloud activity heatmap (`headlessSessionSql`, apps/api) is a FOURTH
 * consumer of the same SSOT constants and is deliberately absent: it is
 * `Prisma.Sql` over Postgres and unreachable from a desktop node suite. It has no
 * equivalent pin of its own — see the ISS-7260 PR body.
 *
 * It is NOT a divergence to fix — it is a contract to pin, because it is
 * load-bearing in both directions. If autonomy silently gained the
 * permissionMode leg, every `cli` + `bypassPermissions` session (218 of the 3,013
 * in the operator's live corpus as of 2026-08-22 — the largest such population)
 * would jump to a fixed autonomy of 100. If the rollup silently LOST it, those
 * same sessions' injected prompts would start inflating `human_turns`.
 *
 * Every expectation in the table below is a LITERAL written from that reasoning,
 * never read out of `HEADLESS_ENTRYPOINT_PREFIXES` / `HEADLESS_ENTRYPOINT_TOKENS`
 * / `HEADLESS_PERMISSION_MODES`, so deleting a member fails this suite instead of
 * quietly redefining what it asserts. The one place a constant IS read is the
 * membership pin on `HEADLESS_PERMISSION_MODES` at the end, and it is asserted
 * AGAINST a literal for the opposite reason: the asymmetric axis grows by
 * ADDITION, which no table of cases can observe.
 */
import assert from "node:assert/strict";
import { HEADLESS_PERMISSION_MODES } from "@repo/lib/session-trace/headless";
import { test } from "vitest";
import { headlessMetadataSql } from "../src/main/database/session-analytics-sql.js";
import { buildSessionAutonomyInput } from "../src/main/database/session-trace-autonomy-input.js";
import { deriveSessionTurnBuckets } from "../src/main/database/turn-buckets.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type AgreementCase = {
  /** Stable id, also the seeded session id. */
  id: string;
  entrypoint: string | null;
  permissionMode: string | null;
  /** What the SESSION-level rule must say (rollup + buckets). */
  sessionHeadless: boolean;
  /** What the ENTRYPOINT-only rule must say (autonomy input). */
  entrypointHeadless: boolean;
  why: string;
};

const CASES: readonly AgreementCase[] = [
  {
    id: "sdk-cli-bypass",
    entrypoint: "sdk-cli",
    permissionMode: "bypassPermissions",
    sessionHeadless: true,
    entrypointHeadless: true,
    why: "the produce-loop shape: both legs fire, both consumers agree",
  },
  {
    id: "sdk-ts-plain",
    entrypoint: "sdk-ts",
    permissionMode: null,
    sessionHeadless: true,
    entrypointHeadless: true,
    why: "the `sdk-` prefix alone is enough for both",
  },
  {
    id: "codex-exec",
    entrypoint: "codex_exec",
    permissionMode: null,
    sessionHeadless: true,
    entrypointHeadless: true,
    why: "the `exec` token alone is enough for both",
  },
  {
    id: "cli-bypass",
    entrypoint: "cli",
    permissionMode: "bypassPermissions",
    sessionHeadless: true,
    entrypointHeadless: false,
    why: "THE deliberate asymmetry — a person at a keyboard with permissions skipped",
  },
  {
    id: "codex-sdk-ts",
    entrypoint: "codex_sdk_ts",
    permissionMode: null,
    sessionHeadless: false,
    entrypointHeadless: false,
    why: "the IDE transport carries `sdk` but is a human typing (golden f04610b7)",
  },
  {
    id: "cli-plain",
    entrypoint: "cli",
    permissionMode: "default",
    sessionHeadless: false,
    entrypointHeadless: false,
    why: "the plain interactive session both consumers must leave alone",
  },
  {
    id: "opencode-plain",
    entrypoint: "opencode",
    permissionMode: null,
    sessionHeadless: false,
    entrypointHeadless: false,
    why: "the largest single population in the live corpus, interactive on both",
  },
  {
    id: "unknown-harness",
    entrypoint: "sdkcli",
    permissionMode: null,
    sessionHeadless: false,
    entrypointHeadless: false,
    why: "ISS-7260: an unrecognized value defaults interactive on BOTH consumers",
  },
  {
    id: "no-signals",
    entrypoint: null,
    permissionMode: null,
    sessionHeadless: false,
    entrypointHeadless: false,
    why: "absent signals are positive-evidence-only: never headless",
  },
];

const HUMAN_TS = "2026-08-01T10:00:00.000Z";

function metadataFor(entry: AgreementCase): string {
  const metadata: Record<string, unknown> = {
    messages: [{ role: "human", timestamp: HUMAN_TS }],
    tokenSeries: [],
  };
  if (entry.entrypoint !== null) {
    metadata.entrypoint = entry.entrypoint;
  }
  if (entry.permissionMode !== null) {
    metadata.permissionMode = entry.permissionMode;
  }
  return JSON.stringify(metadata);
}

test("ISS-7260: the write-time rollup SQL classifies exactly as the expectation table says", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    for (const entry of CASES) {
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO sessions (id, status, started_at, metadata) VALUES ($1,$2,$3,$4)
           ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata`,
          entry.id,
          "inactive",
          HUMAN_TS,
          metadataFor(entry)
        )
      );
    }
    // The predicate is executed by SQLite, not compared as text: a string
    // assertion would stay green against SQL that no longer means what it says.
    const rows = await prisma.read((r) =>
      r.$queryRawUnsafe<{ id: string; headless: number }[]>(
        `SELECT s.id AS id,
                CASE WHEN ${headlessMetadataSql("s.metadata")} THEN 1 ELSE 0 END AS headless
         FROM sessions s ORDER BY s.id`
      )
    );
    const bySql = new Map(
      rows.map((row) => [row.id, Number(row.headless) === 1])
    );
    for (const entry of CASES) {
      assert.equal(
        bySql.get(entry.id),
        entry.sessionHeadless,
        `${entry.id}: ${entry.why}`
      );
    }
  } finally {
    await close();
  }
});

test("ISS-7260: the per-turn buckets suppress the human turn on exactly the same sessions", () => {
  for (const entry of CASES) {
    const buckets = deriveSessionTurnBuckets(
      entry.id,
      metadataFor(entry),
      false
    );
    const humanTurns = buckets
      .filter((bucket) => bucket.turnKind === "human")
      .reduce((total, bucket) => total + bucket.turnCount, 0);
    // Each seed carries exactly ONE `role:"human"` message, so the bucket count
    // is 0 for a headless session and 1 otherwise — asserted as those literals
    // rather than as "matches the predicate", which would be a tautology.
    assert.equal(
      humanTurns,
      entry.sessionHeadless ? 0 : 1,
      `${entry.id}: ${entry.why}`
    );
  }
});

test("ISS-7260: the autonomy input consults the entrypoint leg only, and that is the ONLY disagreement", () => {
  const disagreements: string[] = [];
  for (const entry of CASES) {
    const input = buildSessionAutonomyInput({
      entrypoint: entry.entrypoint,
      hasTranscript: true,
      timelineRows: [
        { eventType: "UserMessage", createdAt: HUMAN_TS, label: "prompt" },
      ],
      tokenEvents: [],
    });
    assert.equal(
      input.headless,
      entry.entrypointHeadless,
      `${entry.id}: ${entry.why}`
    );
    if (input.headless !== entry.sessionHeadless) {
      disagreements.push(entry.id);
    }
  }
  // The whole point: the two rules may differ on the `bypassPermissions`-without-
  // a-headless-entrypoint shape and on NOTHING else. A new disagreement — in
  // either direction — fails here rather than silently moving a chart.
  assert.deepEqual(
    disagreements,
    ["cli-bypass"],
    "autonomy and the Insights consumers may only disagree on an interactive entrypoint carrying bypassPermissions"
  );
  // The asymmetric axis grows by ADDITION, and the table above cannot see that:
  // a second automation mode would make every `cli` session carrying it diverge
  // too, with no case here to observe it. Pinning the membership forces the new
  // mode through the table before it can ship. Deletion is already covered —
  // `cli-bypass` flips the moment the array empties.
  assert.deepEqual(
    [...HEADLESS_PERMISSION_MODES],
    ["bypassPermissions"],
    "a new headless permission mode needs its own agreement case before it ships"
  );
});

test("ISS-7260: the autonomy input does not consult permissionMode even when handed one", () => {
  // The asymmetry above is enforced today by `buildSessionAutonomyInput` not
  // ACCEPTING a permission mode at all, so no mutation of its body can be caught
  // by the table alone. This is the forward guard: hand it the automation flag on
  // the very shape the Insights consumers call headless, and the answer must stay
  // false. Adding the leg here — which ISS-7259 AC3 explicitly reserves to the
  // operator, because `deriveAutonomyAndSteering` returns a flat 100 for a
  // headless session — turns this red instead of silently moving 218 live
  // sessions to a perfect score.
  //
  // Bound to a variable rather than passed inline: an inline literal would fail
  // the excess-property check and this would become a compile error about the
  // test instead of a behavioural assertion about the code.
  const withPermissionMode = {
    entrypoint: "cli",
    hasTranscript: true,
    timelineRows: [
      { eventType: "UserMessage", createdAt: HUMAN_TS, label: "prompt" },
    ],
    tokenEvents: [],
    permissionMode: "bypassPermissions",
  };
  assert.equal(buildSessionAutonomyInput(withPermissionMode).headless, false);
  // The positive sibling on the same call: the entrypoint leg still fires.
  assert.equal(
    buildSessionAutonomyInput({
      ...withPermissionMode,
      entrypoint: "sdk-cli",
    }).headless,
    true
  );
});

test("ISS-7260: every case that disagrees does so for the documented reason", () => {
  // Guards the table itself: an entry may not claim a disagreement unless its
  // permissionMode is the automation flag AND its entrypoint is not headless.
  // Without this a future edit could satisfy the assertion above by inventing a
  // second disagreeing case and adding it to the expected list.
  for (const entry of CASES) {
    if (entry.sessionHeadless === entry.entrypointHeadless) {
      continue;
    }
    assert.equal(entry.permissionMode, "bypassPermissions", entry.id);
    assert.equal(entry.entrypointHeadless, false, entry.id);
    assert.equal(entry.sessionHeadless, true, entry.id);
  }
});
