import type { CostMetricWindow } from "@repo/lib/branches/branch-cost-slices";
import { describe, expect, it } from "vitest";
import { readBranchCostMetricFacts } from "../src/main/database/branch-cost-window-reads.js";
import type { BranchKeyRow } from "../src/main/database/branch-reads.js";
import { BRANCH_WRITE_METHOD_VALUES } from "../src/main/database/db-constants.js";
import { type AcDb, seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

/** ISS-12361: AI spend per window in SQLite, checked against an array oracle. */

const WRITE = BRANCH_WRITE_METHOD_VALUES[0];
const NOT_A_WRITE = "read-only-method";
const REPO = "acme/web";

const D0 = "2026-06-01T00:00:00.000Z";
const D1 = "2026-06-02T12:00:00.000Z";
const D2 = "2026-06-03T12:00:00.000Z";
const D3 = "2026-06-04T12:00:00.000Z";

const WINDOWS: CostMetricWindow[] = [
  { key: "current", startAt: D1, endAt: D2 },
  { key: "prior", startAt: D0, endAt: D1 },
  { key: "both", startAt: D0, endAt: D2 },
  { key: "lifetime", startAt: null, endAt: D3 },
];

type OracleEvent = {
  id: string;
  at: string;
  cost: number | null;
  tokens?: number;
  /** A legacy row with no transport id, which no unique key keeps single. */
  legacy?: boolean;
};
type OracleSession = {
  id: string;
  branches: string[];
  events: OracleEvent[];
  method?: string;
};

type Expected = { spendUsd: number; included: number; unusable: number };

const key = (branch: string): BranchKeyRow => ({
  repoFullName: REPO,
  branchName: branch,
});

describe("readBranchCostMetricFacts", () => {
  it("matches an independent array fold over seeded corpora", async () => {
    await withAcDb(async (db) => {
      for (const seed of [1, 2, 3]) {
        const world = generateWorld(seed);
        await reset(db);
        await seedWorld(db, world);

        const facts = await readBranchCostMetricFacts(db.prisma, {
          cohort: world.cohort.map(key),
          eligible: world.eligible.map(key),
          windows: WINDOWS,
        });

        for (const window of WINDOWS) {
          const expected = oracle(world, window);
          const actual = facts.windows.get(window.key);
          expect(actual?.included, `seed ${seed} ${window.key}`).toBe(
            expected.included
          );
          expect(actual?.unusable, `seed ${seed} ${window.key}`).toBe(
            expected.unusable
          );
          expect(actual?.spendUsd ?? Number.NaN).toBeCloseTo(
            expected.spendUsd,
            9
          );
        }
        expect(facts.cohortHoldsEvents).toBe(oracleHoldsEvents(world));
      }
    });
  }, 120_000);

  it("splits a shared session across every eligible branch it wrote to", async () => {
    await withAcDb(async (db) => {
      await seedWorld(db, {
        cohort: ["a"],
        eligible: ["a", "b", "c"],
        sessions: [
          {
            id: "s1",
            branches: ["a", "b", "c"],
            events: [{ id: "e1", at: D1, cost: 9 }],
          },
        ],
      });

      const facts = await readFacts(db, ["a"], ["a", "b", "c"]);

      expect(facts.windows.get("current")?.spendUsd).toBeCloseTo(3, 12);
    });
  });

  it("keeps the cohort in the divisor even when it is not in the eligible set", async () => {
    await withAcDb(async (db) => {
      await seedWorld(db, {
        cohort: ["a"],
        eligible: ["b"],
        sessions: [
          {
            id: "s1",
            branches: ["a", "b"],
            events: [{ id: "e1", at: D1, cost: 10 }],
          },
        ],
      });

      const facts = await readFacts(db, ["a"], ["b"]);

      expect(facts.windows.get("current")?.spendUsd).toBeCloseTo(5, 12);
    });
  });

  it("ignores a link that is not an active write", async () => {
    await withAcDb(async (db) => {
      await seedWorld(db, {
        cohort: ["a"],
        eligible: ["a", "b"],
        sessions: [
          {
            id: "s1",
            branches: ["a"],
            events: [{ id: "e1", at: D1, cost: 10 }],
          },
          {
            id: "s2",
            branches: ["a"],
            method: NOT_A_WRITE,
            events: [{ id: "e2", at: D1, cost: 500 }],
          },
        ],
      });

      const facts = await readFacts(db, ["a"], ["a", "b"]);

      expect(facts.windows.get("current")?.spendUsd).toBeCloseTo(10, 12);
    });
  });

  it("places an event at a window edge in the window that starts there", async () => {
    await withAcDb(async (db) => {
      await seedWorld(db, {
        cohort: ["a"],
        eligible: ["a"],
        sessions: [
          {
            id: "s1",
            branches: ["a"],
            events: [
              { id: "start", at: D1, cost: 1 },
              { id: "end", at: D2, cost: 100 },
            ],
          },
        ],
      });

      const facts = await readFacts(db, ["a"], ["a"]);

      expect(facts.windows.get("current")).toMatchObject({
        spendUsd: 1,
        included: 1,
      });
      expect(facts.windows.get("prior")).toMatchObject({
        spendUsd: 0,
        included: 0,
      });
    });
  });

  it("counts an unpriced or negative-cost event as unusable, sums the rest, and ignores token counts (ISS-12346 C1)", async () => {
    await withAcDb(async (db) => {
      await seedWorld(db, {
        cohort: ["a"],
        eligible: ["a"],
        sessions: [
          {
            id: "s1",
            branches: ["a"],
            events: [
              { id: "good", at: D1, cost: 4 },
              { id: "unpriced", at: D1, cost: null },
              { id: "negative-cost", at: D1, cost: -3 },
              { id: "negative-tokens", at: D1, cost: 7, tokens: -1 },
            ],
          },
        ],
      });

      const facts = await readFacts(db, ["a"], ["a"]);

      expect(facts.windows.get("current")).toEqual({
        spendUsd: 11,
        included: 2,
        unusable: 2,
      });
    });
  });

  it("counts an event whose instant is not canonical as unusable in every window", async () => {
    await withAcDb(async (db) => {
      await seedWorld(db, {
        cohort: ["a"],
        eligible: ["a"],
        sessions: [
          {
            id: "s1",
            branches: ["a"],
            events: [
              { id: "ok", at: D1, cost: 2 },
              {
                id: "offset-form",
                at: "2026-06-02T13:00:00.000+01:00",
                cost: 50,
              },
              { id: "date-only", at: "2026-06-02", cost: 50 },
            ],
          },
        ],
      });

      const facts = await readFacts(db, ["a"], ["a"]);

      for (const window of WINDOWS) {
        expect(facts.windows.get(window.key)?.unusable, window.key).toBe(2);
      }
      expect(facts.windows.get("current")?.spendUsd).toBe(2);
    });
  });

  it("counts a canonically-shaped impossible instant as unusable in every window", async () => {
    await withAcDb(async (db) => {
      await seedWorld(db, {
        cohort: ["a"],
        eligible: ["a"],
        sessions: [
          {
            id: "s1",
            branches: ["a"],
            events: [
              { id: "ok", at: D1, cost: 2 },
              { id: "minute-60", at: "2026-06-02T12:60:00.000Z", cost: 50 },
              { id: "month-13", at: "2026-13-02T12:00:00.000Z", cost: 50 },
              { id: "day-00", at: "2026-06-00T12:00:00.000Z", cost: 50 },
            ],
          },
        ],
      });

      const facts = await readFacts(db, ["a"], ["a"]);

      for (const window of WINDOWS) {
        expect(facts.windows.get(window.key)?.unusable, window.key).toBe(3);
      }
      expect(facts.windows.get("current")).toMatchObject({
        spendUsd: 2,
        included: 1,
      });
    });
  });

  it("counts identical duplicate rows once", async () => {
    await withAcDb(async (db) => {
      await seedWorld(db, {
        cohort: ["a"],
        eligible: ["a"],
        sessions: [
          {
            id: "s1",
            branches: ["a"],
            events: [
              { id: "dup", at: D1, cost: 6, legacy: true },
              { id: "dup", at: D1, cost: 6, legacy: true },
            ],
          },
        ],
      });

      const facts = await readFacts(db, ["a"], ["a"]);

      expect(facts.windows.get("current")).toMatchObject({
        spendUsd: 6,
        included: 1,
      });
    });
  });

  it("keeps same-name branches in different repositories apart", async () => {
    await withAcDb(async (db) => {
      const seed = seeder(db);
      const web = await seed.branch({ branch: "main", repo: "acme/web" });
      const api = await seed.branch({ branch: "main", repo: "acme/api" });
      for (const [session, artifactId, cost] of [
        ["s-web", web, 1],
        ["s-api", api, 2],
        ["s-both", web, 12],
      ] as const) {
        await seed.session(session);
        await seed.link({ session, artifactId, method: WRITE });
        await db.run(
          `INSERT INTO token_events
             (session_id, transport_id, model, created_at, input_tokens,
              output_tokens, cache_read_tokens, cache_write_tokens,
              cost_usd_estimated)
           VALUES ($1, $2, 'm1', $3, 10, 0, 0, 0, $4)`,
          session,
          `${session}:event`,
          D1,
          cost
        );
      }
      await seed.link({ session: "s-both", artifactId: api, method: WRITE });

      const facts = await readBranchCostMetricFacts(db.prisma, {
        cohort: [{ repoFullName: "acme/web", branchName: "main" }],
        eligible: [
          { repoFullName: "acme/web", branchName: "main" },
          { repoFullName: "acme/api", branchName: "main" },
        ],
        windows: WINDOWS,
      });

      // s-web whole ($1) + s-both split across the two repositories ($6); the
      // api-only session is another repository's and never counts.
      expect(facts.windows.get("current")?.spendUsd).toBeCloseTo(7, 12);
    });
  });

  it("reads 1,200 sessions without a cap", async () => {
    await withAcDb(async (db) => {
      const sessions: OracleSession[] = Array.from(
        { length: 1200 },
        (_, index) => ({
          id: `wide-${index}`,
          branches: ["a"],
          events: [{ id: `wide-e-${index}`, at: D1, cost: 1 }],
        })
      );
      await seedWorld(db, { cohort: ["a"], eligible: ["a"], sessions });

      const facts = await readFacts(db, ["a"], ["a"]);

      expect(facts.windows.get("current")).toMatchObject({
        spendUsd: 1200,
        included: 1200,
        unusable: 0,
      });
    });
  }, 120_000);

  it("says whether the cohort holds any events, apart from any window", async () => {
    await withAcDb(async (db) => {
      await seedWorld(db, {
        cohort: ["a", "quiet"],
        eligible: ["a", "quiet"],
        sessions: [
          {
            id: "s1",
            branches: ["a"],
            events: [{ id: "old", at: "2026-01-01T00:00:00.000Z", cost: 1 }],
          },
          { id: "s2", branches: ["quiet"], events: [] },
        ],
      });

      const held = await readFacts(db, ["a"], ["a", "quiet"]);
      const none = await readFacts(db, ["quiet"], ["a", "quiet"]);

      expect(held.cohortHoldsEvents).toBe(true);
      expect(held.windows.get("current")?.included).toBe(0);
      expect(none.cohortHoldsEvents).toBe(false);
    });
  });

  it("reads nothing for an empty cohort", async () => {
    await withAcDb(async (db) => {
      const facts = await readFacts(db, [], ["a"]);

      expect(facts.cohortHoldsEvents).toBe(false);
      expect(facts.windows.size).toBe(0);
    });
  });
});

function readFacts(db: AcDb, cohort: string[], eligible: string[]) {
  return readBranchCostMetricFacts(db.prisma, {
    cohort: cohort.map(key),
    eligible: eligible.map(key),
    windows: WINDOWS,
  });
}

type World = {
  cohort: string[];
  eligible: string[];
  sessions: OracleSession[];
};

async function reset(db: AcDb): Promise<void> {
  for (const table of [
    "token_events",
    "session_artifact_links",
    "artifacts",
    "sessions",
  ]) {
    await db.run(`DELETE FROM ${table}`);
  }
}

async function seedWorld(db: AcDb, world: World): Promise<void> {
  const seed = seeder(db);
  const branches = new Set([
    ...world.cohort,
    ...world.eligible,
    ...world.sessions.flatMap((session) => session.branches),
  ]);
  const artifactByBranch = new Map<string, string>();
  for (const branch of branches) {
    artifactByBranch.set(branch, await seed.branch({ branch, repo: REPO }));
  }
  for (const session of world.sessions) {
    await seed.session(session.id);
    for (const branch of session.branches) {
      await seed.link({
        session: session.id,
        artifactId: artifactByBranch.get(branch) ?? "",
        method: session.method ?? WRITE,
      });
    }
    for (const event of session.events) {
      await db.run(
        `INSERT INTO token_events
           (session_id, transport_id, model, created_at, input_tokens,
            output_tokens, cache_read_tokens, cache_write_tokens,
            cost_usd_estimated)
         VALUES ($1, $2, 'm1', $3, $4, 0, 0, 0, $5)`,
        session.id,
        event.legacy ? null : `${session.id}:${event.id}`,
        event.at,
        event.tokens ?? 10,
        event.cost
      );
    }
  }
}

function oracleHoldsEvents(world: World): boolean {
  const cohort = new Set(world.cohort);
  return world.sessions.some(
    (session) =>
      (session.method ?? WRITE) === WRITE &&
      session.branches.some((branch) => cohort.has(branch)) &&
      session.events.length > 0
  );
}

function oracle(world: World, window: CostMetricWindow): Expected {
  const cohort = new Set(world.cohort);
  const divisor = new Set([...world.cohort, ...world.eligible]);
  let spendUsd = 0;
  let included = 0;
  let unusable = 0;
  for (const session of world.sessions) {
    if ((session.method ?? WRITE) !== WRITE) {
      continue;
    }
    const touched = new Set(
      session.branches.filter((branch) => divisor.has(branch))
    );
    const inCohort = [...touched].filter((branch) => cohort.has(branch)).length;
    if (inCohort === 0) {
      continue;
    }
    const share = inCohort / touched.size;
    const seen = new Set<string>();
    for (const event of session.events) {
      if (seen.has(event.id)) {
        continue;
      }
      seen.add(event.id);
      const inWindow =
        (window.startAt === null || event.at >= window.startAt) &&
        event.at < window.endAt;
      if (!inWindow) {
        continue;
      }
      if (event.cost === null || event.cost < 0) {
        unusable += 1;
      } else {
        included += 1;
        spendUsd += share * event.cost;
      }
    }
  }
  return { spendUsd, included, unusable };
}

function generateWorld(seed: number): World {
  let state = seed;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  const names = ["a", "b", "c", "d", "e", "f"];
  const cohort = names.filter(() => next() < 0.4);
  const eligible = names.filter(() => next() < 0.7);
  const instants = [D0, D1, D2, D3, "2026-05-30T00:00:00.000Z"];
  const sessions: OracleSession[] = Array.from({ length: 40 }, (_, index) => ({
    id: `s${index}`,
    branches: names.filter(() => next() < 0.3),
    method: next() < 0.1 ? NOT_A_WRITE : undefined,
    events: Array.from({ length: Math.floor(next() * 5) }, (__, eventIndex) => {
      const roll = next();
      return {
        id: `e${eventIndex}`,
        at: new Date(
          Date.parse(instants[Math.floor(next() * instants.length)] ?? D0) +
            Math.floor(next() * 3) * 3_600_000
        ).toISOString(),
        cost: costFor(roll, next()),
        tokens: next() < 0.05 ? -2 : 10,
      };
    }),
  }));
  return { cohort, eligible, sessions };
}

function costFor(roll: number, amount: number): number | null {
  if (roll < 0.1) {
    return null;
  }
  if (roll < 0.15) {
    return -1;
  }
  return Math.round(amount * 1000) / 100;
}
