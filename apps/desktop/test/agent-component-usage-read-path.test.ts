/**
 * @file agent-component-usage-read-path.test.ts
 * @description ISS-5364: proves the E2E agent-component USAGE corpus
 * (`test/e2e/helpers/seed-agent-component-usage-db.ts`) survives the PRODUCTION
 * inventory read, rather than merely inserting rows the reader then filters out.
 *
 * This exists because an E2E seeder is otherwise unfalsifiable from the outside:
 * a corpus that writes cleanly but is dropped by a read predicate produces the
 * same green "the page rendered" as a corpus that works, and the alignment
 * assertions the seeder unblocks would then be measuring a table of identical
 * zeroes. Two predicates in particular are invisible from the usage table and
 * were the reason the desktop adapter could not express ISS-5333's cases at all
 * (see the seeder's module docstring):
 *
 *   - LOC/$ is null for every kind outside `isLocPerDollarVerifiableKind`.
 *   - The LOC numerator (`gitDiffStats`) only populates for a session that owns
 *     a `relation='created'` link to a `kind='commit'` artifact — a gate the
 *     existing branch-only LOC seeders never satisfy.
 *
 * So this executes the seeder's OWN statement list against an ephemeral migrated
 * store, then reads it back through `listAgentComponentsLocal` wired to the real
 * `createSqliteSessionSyncSource` — the same reader and the same session source
 * the packaged renderer's local IPC data source uses.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import {
  getAgentComponentDetailLocal,
  listAgentComponentsLocal,
} from "../src/main/dashboard/shared-agent-components-api.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { backfillSessionAnalytics } from "../src/main/database/session-analytics-maintenance.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  type AgentComponentUsageCorpus,
  agentComponentUsageBatchItems,
  SEEDED_DATA_REVISION,
  seededInvocationLiterals,
} from "./e2e/helpers/seed-agent-component-usage-db.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const OBSERVED_AT = "2026-06-01T00:00:00.000Z";

const PRICED_SESSION_ID = "iss-5364-priced-session";
const UNPRICED_SESSION_ID = "iss-5364-unpriced-session";

const VALUE_COMPONENT_NAME = "acme/iss-5364-value";
const UNAVAILABLE_COMPONENT_NAME = "acme/iss-5364-unavailable";

const PRICED_LINES_ADDED = 900;
const PRICED_LINES_REMOVED = 100;
const PRICED_COST_USD = 4;
// 900 + 100 authored commit lines divided by $4 of priced spend.
const EXPECTED_LOC_PER_DOLLAR = 250;

const VALUE_INVOCATIONS = 12;
const UNAVAILABLE_INVOCATIONS = 3;

/**
 * The exact corpus shape the desktop ISS-5333 alignment spec seeds: one row with
 * a real metric and real counts, one row whose counts are real but whose metric
 * is genuinely unavailable (its invoking session carries no priced spend, so the
 * ratio has no denominator and stays null rather than becoming a fabricated 0).
 */
function corpus(): AgentComponentUsageCorpus {
  return {
    sessions: [
      {
        costUsd: PRICED_COST_USD,
        linesAdded: PRICED_LINES_ADDED,
        linesRemoved: PRICED_LINES_REMOVED,
        sessionId: PRICED_SESSION_ID,
      },
      {
        // No `costUsd` — the unavailable-metric control.
        linesAdded: 40,
        linesRemoved: 10,
        sessionId: UNPRICED_SESSION_ID,
      },
    ],
    components: [
      {
        id: "iss-5364-value",
        key: "iss-5364-value",
        name: VALUE_COMPONENT_NAME,
        usage: [
          { invocations: VALUE_INVOCATIONS, sessionId: PRICED_SESSION_ID },
        ],
      },
      {
        id: "iss-5364-unavailable",
        key: "iss-5364-unavailable",
        name: UNAVAILABLE_COMPONENT_NAME,
        usage: [
          {
            invocations: UNAVAILABLE_INVOCATIONS,
            sessionId: UNPRICED_SESSION_ID,
          },
        ],
      },
    ],
  };
}

/** Run the seeder's own statement list through the store's write path. */
async function applyCorpus(
  prisma: DesktopPrisma,
  seed: AgentComponentUsageCorpus
): Promise<void> {
  for (const item of agentComponentUsageBatchItems(seed, OBSERVED_AT)) {
    await prisma.write((client) =>
      client.$executeRawUnsafe(item.sql, ...item.args)
    );
  }
}

test("ISS-5364: the seeded usage corpus survives listAgentComponentsLocal", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await applyCorpus(prisma, corpus());

    const response = await listAgentComponentsLocal(
      prisma,
      {},
      null,
      createSqliteSessionSyncSource(prisma)
    );

    const value = response.items.find(
      (item) => item.name === VALUE_COMPONENT_NAME
    );
    const unavailable = response.items.find(
      (item) => item.name === UNAVAILABLE_COMPONENT_NAME
    );
    assert.ok(value, "the value row must survive the inventory read");
    assert.ok(unavailable, "the unavailable row must survive the read");

    // The counts are what the sortable count columns render. Asserted as exact
    // values, not merely "> 0": a fold that attributed every usage row to one
    // identity would still clear a non-zero check.
    assert.equal(value.invocations, VALUE_INVOCATIONS);
    assert.equal(value.sessions, 1);
    assert.equal(unavailable.invocations, UNAVAILABLE_INVOCATIONS);
    assert.equal(unavailable.sessions, 1);
    assert.equal(value.kind, AgentComponentKind.Subagent);

    // The metric the alignment spec measures. A real ratio here is the whole
    // point: it proves the authored-commit LOC reached `gitDiffStats` through
    // the real `gitLocRows` gate and divided the real priced spend.
    assert.equal(value.locPerDollar, EXPECTED_LOC_PER_DOLLAR);

    // …and the row that must render the Metric em-dash. Null, never 0 — a
    // fabricated zero would claim the component produced no lines per dollar
    // when the truth is that its spend is unknown.
    assert.equal(unavailable.locPerDollar, null);
  } finally {
    await close();
  }
});

test("ISS-5364: an unpriced session yields no metric even with authored LOC", async () => {
  // The control for the assertion above: it is the SPEND that is missing on the
  // unavailable row, not the churn. Without this, `locPerDollar === null` above
  // would also pass if the corpus never produced any LOC at all — which is
  // precisely the silent-failure mode this file exists to rule out.
  const { prisma, close } = await openTestPrisma();
  try {
    await applyCorpus(prisma, {
      sessions: [
        {
          linesAdded: PRICED_LINES_ADDED,
          linesRemoved: PRICED_LINES_REMOVED,
          sessionId: UNPRICED_SESSION_ID,
        },
      ],
      components: [
        {
          id: "iss-5364-unpriced",
          key: "iss-5364-unpriced",
          name: UNAVAILABLE_COMPONENT_NAME,
          usage: [
            {
              invocations: UNAVAILABLE_INVOCATIONS,
              sessionId: UNPRICED_SESSION_ID,
            },
          ],
        },
      ],
    });

    const response = await listAgentComponentsLocal(
      prisma,
      {},
      null,
      createSqliteSessionSyncSource(prisma)
    );
    const row = response.items.find(
      (item) => item.name === UNAVAILABLE_COMPONENT_NAME
    );
    assert.ok(row);
    assert.equal(row.invocations, UNAVAILABLE_INVOCATIONS);
    assert.equal(row.locPerDollar, null);
  } finally {
    await close();
  }
});

test("ISS-5364: a non-verifiable kind carries counts but no metric", async () => {
  // FEA-4052: `locPerDollarForKind` gates the metric on the KIND, so a corpus
  // that is otherwise identical to the priced one still renders an em-dash when
  // the component is a skill. This is the predicate a seeder that only wrote
  // usage rows would silently trip, and it is why the corpus defaults to
  // `subagent`.
  const { prisma, close } = await openTestPrisma();
  try {
    await applyCorpus(prisma, {
      sessions: [
        {
          costUsd: PRICED_COST_USD,
          linesAdded: PRICED_LINES_ADDED,
          linesRemoved: PRICED_LINES_REMOVED,
          sessionId: PRICED_SESSION_ID,
        },
      ],
      components: [
        {
          id: "iss-5364-skill",
          key: "iss-5364-skill",
          kind: AgentComponentKind.Skill,
          name: VALUE_COMPONENT_NAME,
          usage: [
            { invocations: VALUE_INVOCATIONS, sessionId: PRICED_SESSION_ID },
          ],
        },
      ],
    });

    const response = await listAgentComponentsLocal(
      prisma,
      {},
      null,
      createSqliteSessionSyncSource(prisma)
    );
    const row = response.items.find(
      (item) => item.name === VALUE_COMPONENT_NAME
    );
    assert.ok(row);
    assert.equal(row.kind, AgentComponentKind.Skill);
    assert.equal(row.invocations, VALUE_INVOCATIONS);
    assert.equal(row.locPerDollar, null);
  } finally {
    await close();
  }
});

/**
 * The E2E seeder stamps `sessions.data_revision` with a PINNED copy of
 * `DATA_REVISION`, because importing the real constant into a Playwright spec
 * graph breaks e2e COLLECTION outright (see `SEEDED_DATA_REVISION`'s docstring).
 * This is the drift guard that makes the pin safe.
 *
 * If it ever fails, the seeded sessions have gone stale against the current
 * revision and boot maintenance will re-derive them. Since ISS-5464 the corpus
 * also seeds the `agent_component_invocations` rows that re-derivation reads, so
 * a stale pin no longer empties the rollup — the rebuild reproduces it (that is
 * what the boot-maintenance survival test below proves). The pin is still worth
 * holding: a session left stale is re-derived on every boot for no reason, and
 * the drift is far cheaper to read here than in a Playwright timeout.
 *
 * Fix by updating `SEEDED_DATA_REVISION` in
 * `test/e2e/helpers/seed-agent-component-usage-db.ts` to the new value.
 */
test("the E2E seeder's pinned data revision tracks DATA_REVISION", () => {
  assert.equal(
    SEEDED_DATA_REVISION,
    DATA_REVISION,
    `seed-agent-component-usage-db.ts pins SEEDED_DATA_REVISION=${SEEDED_DATA_REVISION}, but DATA_REVISION is now ${DATA_REVISION}. Update the pin, or the seeded E2E sessions go stale and boot maintenance wipes their agent_component_session_usage rows.`
  );
});

/**
 * ISS-5464: the corpus must survive BOOT MAINTENANCE, not merely a cold read.
 *
 * This is the regression that four separate fixes walked past, because every
 * in-process proof before it read the store the seeder had just written and
 * stopped there. The desktop app does not: `startBootMaintenance`
 * (`src/main/database/boot-maintenance.ts`) runs `backfillSessionAnalytics`
 * FIRST at db open, that pass selects every session lacking a
 * `session_analytics` row — which is every session this seeder writes — and it
 * replaces their component usage from `agent_component_invocations`.
 *
 * Crucially that gate is an anti-join on `session_analytics`, NOT a
 * `data_revision` comparison, so the `SEEDED_DATA_REVISION` pin above does not
 * close it and a corpus can be simultaneously revision-current and destroyed on
 * boot. Before the fix this test's post-boot read returned ZERO sessions and the
 * rollup had been re-keyed to a phantom `tool`/`SeedTool` identity minted from
 * the seeder's own substantive tool event.
 *
 * So the assertions are deliberately made on BOTH sides of the pass, and the
 * pre-boot side is not redundant: without it a corpus that never produced any
 * sessions at all would satisfy the post-boot equality just as well.
 */
test("ISS-5464: the seeded corpus survives boot maintenance", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await applyCorpus(prisma, corpus());

    const read = async () =>
      await getAgentComponentDetailLocal(
        prisma,
        `${AgentComponentKind.Subagent}::iss-5364-value`,
        null,
        createSqliteSessionSyncSource(prisma)
      );

    const before = await read();
    assert.equal(
      before?.sessionsTab.length,
      1,
      "the seeded session must be on the detail Sessions tab before boot"
    );

    // Exactly what `startBootMaintenance` runs first at db open.
    await backfillSessionAnalytics(prisma, () => undefined);

    const after = await read();
    assert.equal(
      after?.sessionsTab.length,
      1,
      "boot maintenance must not empty the seeded Sessions tab — seed agent_component_invocations, never weaken the assertion"
    );
    assert.equal(
      after?.sessions,
      1,
      "the detail Sessions count must survive boot maintenance"
    );
    assert.equal(
      after?.invocations,
      VALUE_INVOCATIONS,
      "the rebuilt rollup must reproduce the seeded invocation count exactly"
    );

    // The identity must still be the seeded component, not a phantom minted
    // from the corpus's own tool event — the precise failure mode ISS-5464 hit.
    const identities = await prisma.client.$queryRawUnsafe<
      { component_kind: string; component_key: string }[]
    >(
      "SELECT DISTINCT component_kind, component_key FROM agent_component_session_usage ORDER BY component_key"
    );
    assert.deepEqual(
      identities.map((row) => `${row.component_kind}::${row.component_key}`),
      ["subagent::iss-5364-unavailable", "subagent::iss-5364-value"],
      "boot maintenance must not re-key the rollup onto a phantom tool identity"
    );
  } finally {
    await close();
  }
});

/**
 * ISS-5464: the seeder pins the invocation enum members as string literals for
 * the same Playwright-loader reason `SEEDED_DATA_REVISION` is pinned (a deep
 * `@repo/api/src/...` specifier collapses e2e collection to "No tests found").
 * This is the drift guard that makes those pins safe — a rename of any member
 * fails here, naming the file, instead of seeding an unrecognised value that
 * silently changes what the rebuild derives.
 */
test("ISS-5464: the seeder's pinned invocation literals track @repo/api", () => {
  assert.deepEqual(
    seededInvocationLiterals(),
    {
      anchorKind: AgentComponentInvocationAnchorKind.Timestamp,
      attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
      evidenceClass: AgentComponentInvocationEvidenceClass.None,
      relationship: AgentComponentInvocationRelationship.Direct,
    },
    "seed-agent-component-usage-db.ts pins the agent_component_invocations enum members as literals; update them to match @repo/api"
  );
});
