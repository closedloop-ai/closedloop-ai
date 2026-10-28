/**
 * ISS-7803: the CLOUD mirror of the headless classification must agree with the
 * DESKTOP `isHeadlessSession` SSOT, session for session.
 *
 * ISS-7260 pinned the desktop side — `apps/desktop/test/headless-consumer-agreement.test.ts`
 * runs the write-time rollup SQL, the per-turn buckets and the autonomy input over
 * one case table and fails when they stop agreeing. The cloud has a FOURTH
 * consumer of the same SSOT constants, `headlessSessionSql` in
 * `app/insights/lib/activity-heatmap.ts`, which reimplements the rule against
 * Postgres and had no equivalent pin: before this suite, `apps/api` seeded no
 * `sdk-`-prefixed entrypoint and no `bypassPermissions` session anywhere, so
 * deleting that query's `HEADLESS_PERMISSION_MODES` disjunct left the whole
 * apps/api suite green while the cloud heatmap silently disagreed with desktop
 * about which sessions were autonomous. Only the `exec` token leg had incidental
 * cover, from one fixture in `insights-heatmap-round-trip-basis.test.ts`.
 *
 * ## What is observed, and why it is the predicate rather than a proxy
 *
 * `headlessSessionSql` is not exported, and testing it as a string would stay
 * green against SQL that no longer means what it says. So each case is driven
 * through the PRODUCTION read path, `insightsService.getUtilization`, and read
 * back off the rendered heatmap cell.
 *
 * Every fixture seeds exactly ONE `role:"human"` message and NO token events,
 * which makes the classification directly legible in the cell: the two halves of
 * the union route that single row on opposite sides of the predicate.
 * `humanTurnsSql` counts it as Human only when `NOT COALESCE(headless, false)`,
 * and `agentLegacyMessageRowsSql` counts it as Agent only when
 * `COALESCE(headless, false)`. So an interactive session reads (human 1, agent 0)
 * and a headless one reads (human 0, agent 1) — the row never leaves the grid,
 * which is what lets a dropped row be told apart from a reclassified one. Each
 * case is seeded at its OWN hour, so one service call yields one cell per case.
 *
 * ## Why agreement is asserted, and why literals are asserted TOO
 *
 * Neither assertion is sufficient alone, and the pair is the point.
 *
 * Comparing each side independently to a constant cannot catch DIVERGENCE, so
 * the second test compares the cloud answer to `isHeadlessSession` row for row
 * on the same input set.
 *
 * But agreement alone cannot catch a change to the SHARED constants: both sides
 * are built from `HEADLESS_ENTRYPOINT_PREFIXES` / `HEADLESS_ENTRYPOINT_TOKENS` /
 * `HEADLESS_PERMISSION_MODES`, so deleting a member moves both answers together
 * and they stay in perfect agreement about a rule that no longer classifies
 * anything. That is why every `headless` value in the table below is a LITERAL,
 * written from the rationale in each `why` and never read out of those constants.
 *
 * ## The dimensions the table has to VARY, not just the values
 *
 * A case only pins a term the input set can actually distinguish. Three terms of
 * the cloud query are invisible to an all-lowercase, prefix-shaped fixture list,
 * so each gets a case chosen to break exactly it:
 *  - CASE FOLDING (`lower()` here, `toLowerCase()` in the SSOT) — every other
 *    entrypoint below is already lowercase, so without `SDK-TS` the two spellings
 *    are byte-identical on this input and deleting `lower()` moves nothing;
 *  - the PREFIX anchor — `sdkcli` breaks a `sdk%` that lost the hyphen, and
 *    `codex-sdk-ts` breaks a `%sdk-%` that lost the front anchor;
 *  - the TOKEN anchor — `codex_exec` ENDS with `exec`, so it cannot tell the
 *    SSOT's unanchored `includes` from a `LIKE '%exec'`; `codex_exec_worker` can.
 * The permission leg is deliberately the odd one out: it is exact-match on both
 * sides, so `BypassPermissions` must stay INTERACTIVE.
 */

import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { isHeadlessSession } from "@repo/lib/session-trace/headless";
import { describe, expect, it } from "vitest";
import { insightsService } from "@/app/insights/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// A fixed "now" after the seeded day so the capped trend window covers it
// regardless of when the suite runs. Mirrors the sibling heatmap suites.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const SESSION_STARTED_AT = new Date("2026-06-10T09:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-06-10T13:00:00.000Z");
const DAY = "2026-06-10";

/**
 * Prisma's interactive-transaction default is 5s, and FIXTURE SETUP alone —
 * one artifact plus one session_detail per case — exceeds it under CI/parallel
 * contention once the table grew past a handful of rows. This raises the budget
 * for that setup cost; it is not covering for a hang, and the assertions still
 * run under the config's own 30s `testTimeout`.
 */
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };

type ParityCase = {
  /** Stable id, also the seeded session's external id. */
  id: string;
  /** This case's own heatmap column, so one service call reads all of them. */
  hour: number;
  entrypoint: string | null;
  permissionMode: string | null;
  /** What the rule must say. A LITERAL — never read from the SSOT constants. */
  headless: boolean;
  why: string;
};

const CASES: readonly ParityCase[] = [
  {
    id: "sdk-cli-bypass",
    hour: 1,
    entrypoint: "sdk-cli",
    permissionMode: "bypassPermissions",
    headless: true,
    why: "the produce-loop shape: both legs fire",
  },
  {
    id: "sdk-ts-plain",
    hour: 2,
    entrypoint: "sdk-ts",
    permissionMode: null,
    headless: true,
    why: "the `sdk-` PREFIX leg alone, with no permission mode to carry it",
  },
  {
    id: "codex-exec",
    hour: 3,
    entrypoint: "codex_exec",
    permissionMode: null,
    headless: true,
    why: "the `exec` TOKEN leg alone",
  },
  {
    id: "cli-bypass",
    hour: 4,
    entrypoint: "cli",
    permissionMode: "bypassPermissions",
    headless: true,
    why: "the PERMISSION leg alone — the disjunct whose deletion left apps/api green",
  },
  {
    id: "codex-sdk-ts",
    hour: 5,
    entrypoint: "codex_sdk_ts",
    permissionMode: null,
    headless: false,
    why: "the IDE transport carries `sdk` but is a person typing (golden f04610b7)",
  },
  {
    id: "sdk-no-hyphen",
    hour: 6,
    entrypoint: "sdkcli",
    permissionMode: null,
    headless: false,
    why: "`sdk-` is a hyphenated prefix rule, NOT the `LIKE 'sdk%'` it once drifted to",
  },
  {
    id: "sdk-not-at-the-start",
    hour: 7,
    entrypoint: "codex-sdk-ts",
    permissionMode: null,
    headless: false,
    why: "contains `sdk-` without STARTING with it — the desktop rule is startsWith, so an unanchored cloud LIKE diverges on exactly this shape",
  },
  {
    id: "cli-default",
    hour: 8,
    entrypoint: "cli",
    permissionMode: "default",
    headless: false,
    why: "the plain interactive session, stating a non-automation permission mode",
  },
  {
    id: "opencode-plain",
    hour: 9,
    entrypoint: "opencode",
    permissionMode: null,
    headless: false,
    why: "the largest single population in the live corpus, interactive",
  },
  {
    id: "no-signals",
    hour: 10,
    entrypoint: null,
    permissionMode: null,
    headless: false,
    why: "absent signals are positive-evidence-only: a NULL predicate is never headless",
  },
  {
    id: "sdk-uppercase",
    hour: 11,
    entrypoint: "SDK-TS",
    permissionMode: null,
    headless: true,
    why: "the entrypoint rule is case-INSENSITIVE — cloud spells that `lower()`, desktop `toLowerCase()`, and the corpus really does stamp capitals (`Codex Desktop`)",
  },
  {
    id: "exec-not-at-the-end",
    hour: 12,
    entrypoint: "codex_exec_worker",
    permissionMode: null,
    headless: true,
    why: "the token rule is an unanchored `includes`, so a cloud LIKE pinned to either end diverges on a value carrying content AFTER the token",
  },
  {
    id: "bypass-wrong-case",
    hour: 13,
    entrypoint: "cli",
    permissionMode: "BypassPermissions",
    headless: false,
    why: "the PERMISSION leg is exact-match on BOTH sides (SQL `=`, JS `includes`) — unlike the entrypoint leg it does NOT fold case",
  },
];

async function createComputeTarget(organizationId: string, userId: string) {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        machineName: "headless-parity-machine",
        organizationId,
        platform: "darwin",
        userId,
      },
      select: { id: true },
    })
  );
  return target.id;
}

/**
 * Seed one case as a session carrying a single `role:"human"` turn at its own
 * hour and no token events. Absent `entrypoint` / `permissionMode` keys are
 * OMITTED rather than written as JSON null, so the `no-signals` case exercises
 * the real absent-key shape the `COALESCE(..., false)` guard exists for.
 */
async function seedCase(
  scope: {
    organizationId: string;
    projectId: string;
    userId: string;
    computeTargetId: string;
  },
  entry: ParityCase
) {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        createdById: scope.userId,
        name: `Headless parity — ${entry.id}`,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        status: SESSION_STATUS.INACTIVE,
        type: ArtifactType.SESSION,
      },
      select: { id: true },
    })
  );
  const metadata: Record<string, unknown> = {
    messages: [
      {
        role: "human",
        timestamp: `${DAY}T${String(entry.hour).padStart(2, "0")}:00:00.000Z`,
      },
    ],
  };
  if (entry.entrypoint !== null) {
    metadata.entrypoint = entry.entrypoint;
  }
  if (entry.permissionMode !== null) {
    metadata.permissionMode = entry.permissionMode;
  }
  await withDb((db) =>
    db.sessionDetail.create({
      data: {
        artifactId: artifact.id,
        computeTargetId: scope.computeTargetId,
        externalSessionId: `session-${entry.id}-${artifact.id}`,
        harness: "claude",
        model: "claude-opus-4",
        sessionStartedAt: SESSION_STARTED_AT,
        lastActivityAt: SESSION_STARTED_AT,
        sessionUpdatedAt: SESSION_UPDATED_AT,
        // Cast to the Prisma JSON input type — the nested shape is valid JSON
        // but TS cannot infer the structural index signature.
        metadata: metadata as Prisma.InputJsonValue,
      },
    })
  );
}

async function seedScope() {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const computeTargetId = await createComputeTarget(organizationId, user.id);
  return { organizationId, projectId, userId: user.id, computeTargetId };
}

/** Seed every case into one fresh org and return the day's cells by hour. */
async function seedAllAndReadCells() {
  const scope = await seedScope();
  for (const entry of CASES) {
    await seedCase(scope, entry);
  }
  const result = await insightsService.getUtilization(
    {
      organizationId: scope.organizationId,
      userId: scope.userId,
      scope: InsightsScope.Org,
      // Bucket in UTC so the seeded hours are deterministic.
      timeZone: "UTC",
    },
    InsightsPeriod.Month,
    NOW
  );
  const cells = (result.charts.activityHeatmap?.cells ?? []).filter(
    (cell) => cell.day === DAY
  );
  return new Map(cells.map((cell) => [cell.hour, cell]));
}

/**
 * The cloud's answer for each case, read off its cell.
 *
 * `counted` travels with the answer rather than being checked separately: the
 * seeded turn must still be ON the grid, claimed by exactly one of the two
 * halves. Without it, a row the query dropped altogether (a broken join, a
 * rejected timestamp) would read as a confident "not headless" and agree with
 * desktop for entirely the wrong reason.
 */
function cloudAnswers(
  cellsByHour: Map<number, { human: number; agent: number }>
): { id: string; counted: number; headless: boolean }[] {
  return CASES.map((entry) => {
    const cell = cellsByHour.get(entry.hour);
    const human = cell?.human ?? 0;
    const agent = cell?.agent ?? 0;
    return { id: entry.id, counted: human + agent, headless: agent === 1 };
  });
}

describe.skipIf(!hasDatabase)(
  "cloud headlessSessionSql mirrors the desktop isHeadlessSession SSOT (ISS-7803)",
  () => {
    it("classifies every seeded session exactly as the expectation table says", async () => {
      await autoRollbackTransaction(async () => {
        const cellsByHour = await seedAllAndReadCells();

        for (const entry of CASES) {
          const cell = cellsByHour.get(entry.hour);
          // Literals, not "matches the predicate": a headless session's injected
          // prompt is suppressed as Human and promoted to Agent, an interactive
          // one's typed prompt stays Human.
          expect(cell?.human, `${entry.id}: ${entry.why}`).toBe(
            entry.headless ? 0 : 1
          );
          expect(cell?.agent, `${entry.id}: ${entry.why}`).toBe(
            entry.headless ? 1 : 0
          );
        }
      }, TRANSACTION_OPTIONS);
    });

    it("agrees with the desktop predicate row for row on the same input set", async () => {
      await autoRollbackTransaction(async () => {
        const cellsByHour = await seedAllAndReadCells();

        // The load-bearing assertion of the ticket. Comparing each side to a
        // constant independently cannot catch the two surfaces DRIFTING APART;
        // this runs both over one input set and compares them to each other.
        const cloud = cloudAnswers(cellsByHour);
        const desktop = CASES.map((entry) => ({
          id: entry.id,
          // The literal 1: every case seeds exactly one turn, so a cloud row
          // that lost or double-counted its turn fails HERE rather than being
          // silently reduced to a boolean that happens to match.
          counted: 1,
          headless: isHeadlessSession({
            entrypoint: entry.entrypoint,
            permissionMode: entry.permissionMode,
          }),
        }));

        expect(cloud).toEqual(desktop);
      }, TRANSACTION_OPTIONS);
    });

    it("covers every leg of the predicate the cloud query implements", () => {
      // Guards the fixture set itself. The two tests above are only as strong as
      // the cases they run, and each leg is a separate disjunct that a diff can
      // delete on its own — so pin that a case exists which fires that leg and
      // NOTHING else, and that the interactive controls which discriminate the
      // prefix rule from a looser `sdk` match are present.
      const entrypointOnly = CASES.filter(
        (entry) => entry.headless && entry.permissionMode === null
      ).map((entry) => entry.entrypoint);
      expect(entrypointOnly).toContain("sdk-ts");
      expect(entrypointOnly).toContain("codex_exec");
      // The case dimension. Without a mixed-case fixture, dropping `lower()`
      // from the cloud query moves nothing on an all-lowercase table and both
      // tests above stay green while the two surfaces genuinely diverge.
      expect(entrypointOnly).toContain("SDK-TS");
      // The token leg's own anchor control: `codex_exec` ENDS with the token, so
      // it alone cannot tell an unanchored `%exec%` from a trailing `%exec`.
      expect(entrypointOnly).toContain("codex_exec_worker");

      const permissionOnly = CASES.filter(
        (entry) => entry.headless && entry.entrypoint === "cli"
      );
      expect(permissionOnly).toHaveLength(1);
      expect(permissionOnly[0]?.permissionMode).toBe("bypassPermissions");

      // The permission leg is exact-match on both sides. Its control must stay
      // interactive, so a `lower()` added to that leg diverges from desktop.
      const permissionWrongCase = CASES.filter(
        (entry) => entry.permissionMode === "BypassPermissions"
      );
      expect(permissionWrongCase).toHaveLength(1);
      expect(permissionWrongCase[0]?.headless).toBe(false);

      const interactive = CASES.filter((entry) => !entry.headless).map(
        (entry) => entry.entrypoint
      );
      expect(interactive).toContain("codex_sdk_ts");
      // The two shapes that discriminate the PREFIX rule from a looser match:
      // one drops the hyphen, one moves `sdk-` off the front.
      expect(interactive).toContain("sdkcli");
      expect(interactive).toContain("codex-sdk-ts");

      // Every case must own its column, or two of them would share a cell and
      // their counts would add instead of being read separately.
      expect(new Set(CASES.map((entry) => entry.hour)).size).toBe(CASES.length);
    });
  }
);
