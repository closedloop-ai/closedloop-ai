import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";
import {
  type DeclaredTimeout,
  declaredTimeoutsIn,
  localImportSpecifiers,
  OBJECT_PHASE_PREFIX,
  worstOverBoundByFile,
} from "@/__tests__/support/integration-timeout-declarations.test-helpers.ts";

// ISS-8542. The `api-integration-tests` job was reaped at its `timeout-minutes:
// 15` cap on ~18% of runs (13 of 72 sampled). In all 13, the last suite the
// reporter printed a start line for was the same one, and it never printed that
// suite's result; the ~9 suites ahead of it had finished on the same clock as a
// green run. That is where the stall was, INFERRED from start lines — the cause
// of the stall is not known, and this change does not fix it.
//
// A reap is still the worst available outcome: the job is killed mid-run, so
// Vitest never prints a summary and the per-file results of all ~124 suites are
// lost — including any genuine failure among them, and the Datadog upload. The
// raw runner log survives, which is the only reason the localization above was
// possible at all.
//
// What made a stall unfailable was the suite's own timeout budget, not the
// stall. That suite declared per-test and per-transaction bounds of 60s/120s/
// 180s against a measured worst case of 7.6s across 14 green CI runs — a budget
// summing past 600s inside a job whose entire spare headroom is ~380s (a ~520s
// normal run under a 900s cap). A suite that may outlast the job cannot report
// a failure; it can only take the job down.
//
// So bound the declared budget rather than the cap: the tier already owns one
// number (`testTimeout` in vitest.config.integration.mts, with a comment saying
// the budget belongs there rather than in each suite), and no suite it collects
// may declare a longer one. Within the tier's bound a stall fails loudly, names
// the test, and leaves the other 123 files' results intact.
//
// Read from the RESOLVED config rather than a literal, so raising the tier's
// budget moves this bound with it instead of silently unpinning it.

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const INTEGRATION_CONFIG = "vitest.config.integration.mts";
const RESOLVE_TIMEOUT_MS = 60_000;
/**
 * The segment that marks a module as test support. `apps/api/AGENTS.md` puts
 * every harness, mock, and fixture under `__tests__/`, so this is the whole
 * population a collected suite can hoist a timeout into — and the boundary that
 * keeps the walk off production source, where a `timeout:` on an HTTP client
 * option is not a test budget at all.
 */
const TEST_SUPPORT_SEGMENT = "__tests__/";
const JS_EXTENSION_PATTERN = /\.js$/;
const ALIAS_PREFIX = "@/";
/**
 * Reached by the collected suite ONLY through the `@/` alias, so it is the walk's
 * probe for that hop: a reader that follows relative specifiers alone drops this
 * module and, with it, any bound hoisted into it.
 */
const ALIAS_ONLY_SUPPORT_MODULE =
  "__tests__/support/integration/migration-upgrade-harness.ts";

/**
 * Suites the tier's bound cannot hold, each pinned at its current worst declared
 * value. SHRINK-ONLY, exactly like biome.jsonc's grandfather list: lower an
 * entry when a suite is brought down, delete it when the suite reaches the tier
 * bound, and never add one — a new entry is a new suite that can reap the job.
 * ISS-10525 removed the separate base-ref shrink-only check. This file alone
 * cannot tell a lowered entry from a raised one, so keeping the ledger
 * shrink-only is now review-owned.
 *
 * ISS-8553 emptied the other fifteen. Each was declared against a guess rather
 * than a measurement, and every one measured (Datadog Test Optimization,
 * `@test.service:symphony-api-integration`, 14 days to 2026-09-06) far under the
 * tier's own 30s — `golden-corpus-insights` declared 300_000 against a 14.45s
 * worst test, `branch-product-read-snapshot` 30_000 against 1.91s. Their
 * declarations are gone rather than lowered, per the note below: the tier owns
 * the number.
 *
 * Three of the fifteen budgeted a HOOK, which no per-test number can speak for,
 * so those were sized against the WHOLE-SUITE measurement instead.
 * `custom-field-list-bounds` declared 600_000 twelve times — ten tests whose
 * worst measured 1.11s, plus a `beforeAll`/`afterAll` pair around a seed no test
 * re-runs — and its whole suite measures 9.66-12.27s (median 10.30s, n~600).
 * Its one excursion past that is 33.94s on 2026-09-01
 * (`actions/runs/33508175928/job/99857240570`), and it is NOT a reaped run: the
 * suite record reports `pass`, so the seed completed and reported. Decomposed,
 * that run spent 2.70s across its eight reported tests and 31.23s on everything
 * else — the `beforeAll` seed, the `afterAll`, and file import. That residual is
 * over the tier's 30s `hookTimeout`, though it is a SUM the hook bound is not
 * applied to, so what it establishes is a thin margin rather than a proven
 * breach. It is one run in ~600, and inside the tier it now fails loudly and
 * names the hook instead of reaping the job — which is the trade this whole
 * change makes. `custom-field-sort-empty` and `document-list-snapshot` budget
 * hooks at 120_000 against whole-suite worsts of 1.63s and 1.62s.
 *
 * The sixteenth was emptied by RESTRUCTURE, not by shrinking: at a measured
 * 112.46s worst case, tightening its bound would have failed a passing test
 * rather than bounded a stall. `branch-artifact-incident-scenarios`' case
 * `returns deterministic references for the same namespace across isolated DBs`
 * provisioned six disposable databases and replayed 147 base migrations into
 * each. That replay is identical every time, so it now runs ONCE into a template
 * database in a suite-level `beforeAll` and every scenario clones it with
 * `CREATE DATABASE ... TEMPLATE`. Each scenario still gets a database of its
 * own — the isolation the case is named for is unchanged — and the cost the
 * bound was sized against is gone rather than re-declared.
 *
 * Measured back to back on one box, same command both times: that case went
 * 28,847ms to 1,467ms and the whole file 57,511ms to 13,437ms, of which the new
 * hook is 3,563ms (file wall minus the summed test durations, the same
 * decomposition used above). CI's worst run of that case was 3.9x this box's
 * before-number, so the hook has roughly 2x headroom under the tier's 30s
 * `hookTimeout` — and unlike the old 180_000, an overrun now fails loudly inside
 * the tier instead of outlasting the job cap.
 *
 * The ledger is empty. Adding an entry would permit a suite to exceed the
 * tier's timeout budget; no separate gate now rejects that addition.
 *
 * An entry sitting at EXACTLY the tier bound is one of two shapes, and the fix
 * differs. A bound spent inside a phase (a transaction option) at the phase's
 * own value is the detached-transaction race itself — shrink it. A phase's own
 * trailing argument at the tier's value is merely a restatement of the number
 * the tier already owns — DELETE it rather than shrink it, per the config's own
 * note that the budget belongs in the tier and not in each suite.
 */
const GRANDFATHERED_DECLARED_TIMEOUT_MS: Readonly<Record<string, number>> = {};

/**
 * The file a local specifier names, if this package holds one. `@/` is anchored
 * at the package root exactly as `tsconfig.json` and both vitest configs map it;
 * everything else is relative to the importer. NodeNext spells a TypeScript
 * sibling with a `.js` suffix, so that rewrite is tried too; a specifier nothing
 * answers resolves to null and is simply not followed.
 */
async function resolveLocalModule(
  fromFile: string,
  specifier: string
): Promise<string | null> {
  const base = specifier.startsWith(ALIAS_PREFIX)
    ? path.resolve(APP_ROOT, specifier.slice(ALIAS_PREFIX.length))
    : path.resolve(APP_ROOT, path.dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(JS_EXTENSION_PATTERN, ".ts"),
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return path.relative(APP_ROOT, candidate);
    } catch {
      // Not this spelling; try the next.
    }
  }
  return null;
}

/**
 * The collected suites plus every `__tests__/` module they transitively import.
 *
 * A bound the tier cannot see is a bound it cannot hold, and a shared fixture
 * module is not itself collected: `ROLLBACK_OPTIONS` sat in
 * `__tests__/integration/iss8463-stub-backfill-fixtures.ts`, spent by three
 * collected suites through an identifier that names no timeout key, so the walk
 * had nothing to read and nothing to report unresolved either. Taking that
 * declaration back over the tier's bound left this guard green.
 *
 * Relative AND `@/`-aliased imports alike: `apps/api/AGENTS.md` tells consumers
 * to reach support through the alias, so a walk that followed only relative
 * specifiers was blind to the spelling the rule actually prescribes — 31 of the
 * tier's 104 collected suites use it (ISS-8553).
 *
 * Transitive rather than one hop: a fixture module importing a second one is the
 * same hole one level down. Bounded by the `__tests__/` filter and by the seen
 * set, so a cycle terminates.
 */
async function withImportedSupport(collected: string[]): Promise<string[]> {
  const seen = new Set(collected);
  const queue = [...collected];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const source = await readFile(path.join(APP_ROOT, file), "utf8");
    for (const specifier of localImportSpecifiers(file, source)) {
      const resolved = await resolveLocalModule(file, specifier);
      if (
        resolved === null ||
        seen.has(resolved) ||
        !resolved.includes(TEST_SUPPORT_SEGMENT)
      ) {
        continue;
      }
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return [...seen].sort();
}

async function resolveIntegrationTier(): Promise<{
  files: string[];
  hookTimeout: number;
  testTimeout: number;
}> {
  const vitest = await createVitest("test", {
    watch: false,
    run: true,
    root: APP_ROOT,
    config: path.join(APP_ROOT, INTEGRATION_CONFIG),
  });
  try {
    const specifications = await vitest.globTestSpecifications();
    const unique = new Set(
      specifications.map((specification) =>
        path.relative(APP_ROOT, specification.moduleId)
      )
    );
    const { hookTimeout, testTimeout } = vitest.config;
    if (typeof testTimeout !== "number" || typeof hookTimeout !== "number") {
      throw new Error(
        `${INTEGRATION_CONFIG} resolved no testTimeout/hookTimeout; the tier bound is unreadable`
      );
    }
    return { files: [...unique].sort(), hookTimeout, testTimeout };
  } finally {
    await vitest.close();
  }
}

describe("apps/api integration-tier timeout budget (ISS-8542)", () => {
  it(
    "lets no collected suite exceed the tier's own budget beyond the frozen grandfather set",
    async () => {
      const { files: collected, ...bounds } = await resolveIntegrationTier();
      expect(collected.length).toBeGreaterThan(0);
      // The suites plus the fixture modules they hoist declarations into; a
      // bound one file over is the same bound.
      const files = await withImportedSupport(collected);
      expect(files.length).toBeGreaterThan(collected.length);
      // Named rather than counted: the walk grows past `collected` on relative
      // imports alone, so only a module reachable ONLY through `@/` proves that
      // hop is followed.
      expect(files).toContain(ALIAS_ONLY_SUPPORT_MODULE);

      const declared: DeclaredTimeout[] = [];
      const unresolved: string[] = [];
      for (const file of files) {
        const source = await readFile(path.join(APP_ROOT, file), "utf8");
        const found = declaredTimeoutsIn(file, source);
        declared.push(...found.resolved);
        unresolved.push(...found.unresolved);
      }
      // A bound this guard cannot read is a bound it cannot enforce, so it is a
      // failure here rather than a silent omission from the set below.
      expect(unresolved).toEqual([]);
      // A resolver that collected nothing, or an AST walk that matched nothing,
      // would report an empty over-bound set and read as a clean tier.
      expect(declared.length).toBeGreaterThan(0);

      const overBound = [...worstOverBoundByFile(declared, bounds)]
        .map(([file, milliseconds]) => ({ file, milliseconds }))
        .sort((left, right) => left.file.localeCompare(right.file));

      const expectedOverBound = Object.entries(
        GRANDFATHERED_DECLARED_TIMEOUT_MS
      )
        .map(([file, milliseconds]) => ({ file, milliseconds }))
        .sort((left, right) => left.file.localeCompare(right.file));

      expect(overBound).toEqual(expectedOverBound);
    },
    RESOLVE_TIMEOUT_MS
  );

  it(
    "keeps the localized suite's per-test transaction budget under the tier's bound, sequences summed",
    async () => {
      const file =
        "__tests__/integration/ingest-writer-bind-parameter-ceiling.integration.test.ts";
      const { files, ...bounds } = await resolveIntegrationTier();
      // The bound below is only meaningful while the tier still collects this
      // suite; a rename would otherwise pass vacuously against a stale path.
      expect(files).toContain(file);
      const source = await readFile(path.join(APP_ROOT, file), "utf8");
      const { resolved, unresolved } = declaredTimeoutsIn(file, source);

      expect(unresolved).toEqual([]);
      // A suite that declared nothing would pass the bound vacuously while its
      // transactions ran on Prisma's 5s default, so pin that it still declares.
      expect(resolved.length).toBeGreaterThan(0);
      // One test here awaits TWO transactions in sequence, so the max is not
      // the number that has to fit — the per-test sum is. STRICTLY under, not
      // merely within: Prisma arms a transaction's clock after BEGIN, later
      // than Vitest arms the test's, so at equal values Vitest fails the test
      // first and leaves the transaction running detached, holding a pooled
      // connection and naming nothing.
      expect([...worstOverBoundByFile(resolved, bounds)]).toEqual([]);
    },
    RESOLVE_TIMEOUT_MS
  );
});

// The suite above reads the real tier, so it can only fail on what the tier
// happens to declare today — no collected suite currently writes any of the
// forms below, which is exactly why each was unreadable without anyone
// noticing. These pin the reader itself against synthetic sources, so a fix
// that regresses fails here instead of going quiet.
const SYNTHETIC_FILE = "synthetic.integration.test.ts";
const SYNTHETIC_BOUNDS = { hookTimeout: 20_000, testTimeout: 30_000 };

function resolvedIn(source: string): DeclaredTimeout[] {
  return declaredTimeoutsIn(SYNTHETIC_FILE, source).resolved;
}

/** Source straight through the real reader to the real verdict. */
function overBoundIn(source: string): [string, number][] {
  return [...worstOverBoundByFile(resolvedIn(source), SYNTHETIC_BOUNDS)];
}

/**
 * The phase key an unattributed bound takes from the object literal holding it,
 * spelled from the source rather than copied from the reader — a key derived by
 * calling the code under test would agree with itself however wrong it was.
 */
function objectPhase(source: string, literal: string): string {
  const at = source.indexOf(literal);
  if (at < 0) {
    throw new Error(`fixture does not contain ${literal}`);
  }
  return `${OBJECT_PHASE_PREFIX}${at}`;
}

describe("declaration forms the tier bound must be readable through", () => {
  it("reads a `{ timeout }` shorthand through the constant it names", () => {
    const source = "const timeout = 60_000;\nconst options = { timeout };\n";
    expect(resolvedIn(source)).toEqual([
      {
        file: SYNTHETIC_FILE,
        kind: "either",
        milliseconds: 60_000,
        phase: objectPhase(source, "{ timeout }"),
      },
    ]);
  });

  it("reads a quoted or computed `timeout` key", () => {
    const source =
      'const a = { "timeout": 60_000 };\nconst b = { ["timeout"]: 90_000 };\n';
    expect(resolvedIn(source)).toEqual([
      {
        file: SYNTHETIC_FILE,
        kind: "either",
        milliseconds: 60_000,
        phase: objectPhase(source, '{ "timeout": 60_000 }'),
      },
      {
        file: SYNTHETIC_FILE,
        kind: "either",
        milliseconds: 90_000,
        phase: objectPhase(source, '{ ["timeout"]: 90_000 }'),
      },
    ]);
  });

  it("sums `maxWait` with the `timeout` it precedes, hoisted or inline", () => {
    // Prisma spends `maxWait` waiting for a pooled connection and only then
    // arms `timeout`, so 20s + 25s is 45s of one 30s test. Each half clears the
    // bound alone, which is how this shape stayed invisible.
    expect(
      overBoundIn("const TX = { maxWait: 20_000, timeout: 25_000 };\n")
    ).toEqual([[SYNTHETIC_FILE, 45_000]]);
    expect(
      overBoundIn(
        'it("x", async () => { await tx({ maxWait: 20_000, timeout: 25_000 }); });\n'
      )
    ).toEqual([[SYNTHETIC_FILE, 45_000]]);
    // Two hoisted literals are two transactions with two budgets: 19s each
    // under the stricter 20s bound an unattributed bound answers to here.
    // Merging them into one 38s group would red a correct suite, which is the
    // failure mode of grouping per FILE instead of per literal.
    expect(
      overBoundIn(
        "const A = { maxWait: 5_000, timeout: 14_000 };\nconst B = { maxWait: 5_000, timeout: 14_000 };\n"
      )
    ).toEqual([]);
  });

  it("takes a timeout option's kind from the phase that awaits it", () => {
    const [hook] = resolvedIn(
      "beforeAll(async () => { await tx({ timeout: 25_000 }); });\n"
    );
    expect(hook).toMatchObject({ kind: "hook", milliseconds: 25_000 });
    const [test] = resolvedIn(
      'it("x", async () => { await tx({ timeout: 25_000 }); });\n'
    );
    expect(test).toMatchObject({ kind: "test", milliseconds: 25_000 });
    // Spent from the phase, so it carries that phase and can join its sum.
    // A null here is what let two sequential transactions each pass alone.
    expect(hook?.phase).not.toBeNull();
    expect(test?.phase).not.toBeNull();
  });

  it("still reads the trailing positional bound on a test and on a hook", () => {
    expect(resolvedIn('it("x", async () => {}, 60_000);\n')).toEqual([
      { file: SYNTHETIC_FILE, kind: "test", milliseconds: 60_000, phase: null },
    ]);
    expect(resolvedIn("beforeAll(async () => {}, 60_000);\n")).toEqual([
      { file: SYNTHETIC_FILE, kind: "hook", milliseconds: 60_000, phase: null },
    ]);
  });

  it("reads `it(name, { timeout }, fn)` without reporting the callback", () => {
    expect(
      declaredTimeoutsIn(
        SYNTHETIC_FILE,
        'it("x", { timeout: 25_000 }, async () => {});\n'
      )
    ).toEqual({
      resolved: [
        {
          file: SYNTHETIC_FILE,
          kind: "test",
          milliseconds: 25_000,
          phase: null,
        },
      ],
      unresolved: [],
    });
  });

  it("refuses to resolve a constant two declarations disagree about", () => {
    const source = [
      "const T = 60_000;",
      'it("outer", async () => { await tx({ timeout: T }); });',
      'describe("d", () => {',
      "  const T = 20_000;",
      '  it("inner", async () => { await tx({ timeout: T }); });',
      "});",
      "",
    ].join("\n");
    const { resolved, unresolved } = declaredTimeoutsIn(SYNTHETIC_FILE, source);
    expect(resolved).toEqual([]);
    expect(unresolved).toHaveLength(2);
  });

  it("holds each kind to its own bound, and an unattributed one to the stricter", () => {
    const over = (kind: DeclaredTimeout["kind"]) => [
      ...worstOverBoundByFile(
        [{ file: SYNTHETIC_FILE, kind, milliseconds: 25_000, phase: null }],
        SYNTHETIC_BOUNDS
      ),
    ];
    expect(over("hook")).toEqual([[SYNTHETIC_FILE, 25_000]]);
    expect(over("either")).toEqual([[SYNTHETIC_FILE, 25_000]]);
    // Under `testTimeout`, so the test bound is the one that lets it pass.
    expect(over("test")).toEqual([]);
  });

  it("counts a bound equal to its phase's budget as over it, hook and test alike", () => {
    // Equality is the race, not the safe edge — Vitest arms first, so at equal
    // values it fails the test and the transaction runs on detached. `>` let
    // every one of these through without so much as a ledger entry.
    expect(
      overBoundIn(
        "beforeAll(async () => { await tx({ timeout: 20_000 }); });\n"
      )
    ).toEqual([[SYNTHETIC_FILE, 20_000]]);
    expect(
      overBoundIn('it("x", async () => { await tx({ timeout: 30_000 }); });\n')
    ).toEqual([[SYNTHETIC_FILE, 30_000]]);
    // A phase's own budget written at the tier's value is caught by the same
    // rule; the fix there is deleting a declaration the tier already owns.
    expect(overBoundIn("beforeAll(async () => {}, 20_000);\n")).toEqual([
      [SYNTHETIC_FILE, 20_000],
    ]);
    expect(overBoundIn('it("x", async () => {}, 30_000);\n')).toEqual([
      [SYNTHETIC_FILE, 30_000],
    ]);
    // One millisecond under each bound is the safe side and stays unflagged,
    // so the rule above is equality and not "everything at this magnitude".
    expect(
      overBoundIn(
        "beforeAll(async () => { await tx({ timeout: 19_999 }); });\n"
      )
    ).toEqual([]);
    expect(
      overBoundIn('it("x", async () => { await tx({ timeout: 29_999 }); });\n')
    ).toEqual([]);
  });

  it("sums the bounds spent from one phase, and keeps separate phases apart", () => {
    // Each 20s transaction clears the 30s test bound alone; awaited in
    // sequence they cannot both finish, and the second is the one left
    // detached when Vitest reaps the test.
    expect(
      overBoundIn(
        'it("x", async () => { await tx({ timeout: 20_000 }); await tx({ timeout: 20_000 }); });\n'
      )
    ).toEqual([[SYNTHETIC_FILE, 40_000]]);
    // The same two bounds in two tests spend two separate budgets. Summing
    // per FILE rather than per phase would red this correct suite.
    expect(
      overBoundIn(
        'it("a", async () => { await tx({ timeout: 20_000 }); });\nit("b", async () => { await tx({ timeout: 20_000 }); });\n'
      )
    ).toEqual([]);
  });

  it("never adds a phase's own budget to the bounds spent from it", () => {
    // 25s is what the test may take and 20s is spent inside that: correct
    // code. Adding the two would report a 45s declaration and red it.
    expect(
      overBoundIn(
        'it("x", { timeout: 25_000 }, async () => { await tx({ timeout: 20_000 }); });\n'
      )
    ).toEqual([]);
    expect(
      overBoundIn(
        'it("x", async () => { await tx({ timeout: 20_000 }); }, 25_000);\n'
      )
    ).toEqual([]);
  });
});
