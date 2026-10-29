import { Prisma, type TransactionClient } from "@repo/database";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { mockDeep } from "vitest-mock-extended";
import {
  asTx,
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "@/__tests__/utils/db-helpers";
import {
  findPhantoms,
  main,
  type PhantomCandidate,
  purgePhantoms,
} from "../../scripts/purge-phantom-sessions.js";
import type { ScriptOutput } from "../../scripts/script-progress-output.js";

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    // `Prisma` deliberately stays REAL. The org-scoping assertions below inspect
    // the actual `Prisma.Sql` fragment the script interpolates; against a stubbed
    // `Prisma.sql` they would only describe the stub's shape, which is the same
    // class of non-test this file is being repaired for.
    withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  };
});

const mockCandidate = (
  overrides: Partial<PhantomCandidate> = {}
): PhantomCandidate => ({
  artifactId: "art-1",
  externalSessionId: "ses-1",
  organizationId: "org-1",
  eventCount: BigInt(25),
  eventSpanMs: 200,
  ...overrides,
});

describe("findPhantoms", () => {
  it("omits the org predicate entirely when orgId is null", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await findPhantoms(asTx({ $queryRaw: queryRaw }), null);

    const { fragment } = capturedOrgFilter(queryRaw);
    // An EMPTY fragment is the whole claim: the statement pg receives carries no
    // organization predicate, so the sweep is deliberately cross-org.
    expect(fragment.sql).toBe("");
    expect(fragment.values).toEqual([]);
  });

  it("splices a parameterized org predicate into the WHERE clause when orgId is provided", async () => {
    const queryRaw = vi.fn().mockResolvedValue([mockCandidate()]);

    const result = await findPhantoms(
      asTx({ $queryRaw: queryRaw }),
      TEST_ORG_ID
    );

    const { before, fragment, after } = capturedOrgFilter(queryRaw);
    expect(fragment.sql).toMatch(ORG_PREDICATE_SQL);
    // Parameterized, not concatenated: the id reaches pg as a bind value.
    expect(fragment.values).toEqual([TEST_ORG_ID]);
    // ...and it is spliced between the `tu."id" IS NULL` predicate and GROUP BY,
    // i.e. inside the WHERE clause, rather than somewhere inert.
    expect(before).toMatch(WHERE_CLAUSE_TAIL);
    expect(after).toMatch(GROUP_BY_HEAD);
    expect(result).toEqual([mockCandidate()]);
  });
});

describe("purgePhantoms", () => {
  it("returns 0 for empty candidates without DB call", async () => {
    const mockTx = mockDeep<TransactionClient>({
      fallbackMockImplementation: failUnconfiguredTxMember,
    });
    const count = await purgePhantoms(mockTx, []);
    expect(count).toBe(0);
    expect(mockTx.artifact.deleteMany).not.toHaveBeenCalled();
  });

  it("returns actual deleted count from deleteMany", async () => {
    const mockTx = mockDeep<TransactionClient>({
      fallbackMockImplementation: failUnconfiguredTxMember,
    });
    mockTx.artifact.deleteMany.mockResolvedValue({ count: 3 });
    const candidates = [
      mockCandidate({ artifactId: "a1" }),
      mockCandidate({ artifactId: "a2" }),
      mockCandidate({ artifactId: "a3" }),
      mockCandidate({ artifactId: "a4" }),
    ];
    const count = await purgePhantoms(mockTx, candidates);
    expect(count).toBe(3);
    expect(mockTx.artifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2", "a3", "a4"] } },
    });
  });
});

describe("main — dry-run default", () => {
  let pooledDb: ReturnType<typeof createMockDb>;
  let txDb: ReturnType<typeof createMockDb>;
  let output: ReturnType<typeof createMockOutput>;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv = captureEnv("DRY_RUN", "ORG_ID");
    // SEPARATE clients returning DIFFERENT candidates. Pointing both `withDb`
    // and `withDb.tx` at one mock made the delete assertion vacuous: the pooled
    // preview and the in-transaction re-find handed back the same row, so
    // moving the second `findPhantoms` outside `withDb.tx` — or ignoring its
    // result and deleting the pooled rows — still produced that row's id and
    // stayed green. With distinct ids, the id `deleteMany` receives names which
    // read actually fed the cascade.
    pooledDb = createMockDb(POOLED_CANDIDATE_ID);
    txDb = createMockDb(TX_CANDIDATE_ID);
    output = createMockOutput();
    mockWithDbCall(pooledDb);
    mockWithDbTx(txDb);
    // Defensive only: nothing below should trip the ORG_ID guard, but a no-op
    // `process.exit` would let a mutated `main()` run on, and an unmocked one
    // would take the vitest worker down with it. Throwing keeps a surprise
    // loud and local. (Same reasoning as the cross-org test further down.)
    vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null | undefined
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  // These three assert the WRITE, not the env var. The observable that separates
  // dry run from execute is whether `artifact.deleteMany` is REACHED — re-deriving
  // `process.env.DRY_RUN !== "0"` in the test body (what this block used to do)
  // asserts that JavaScript works, and stays green with the guard deleted.
  //
  // ORG_ID is set in the DRY_RUN cases so that branch is the only variable: the
  // execute-mode guard is a separate contract, covered on its own below.
  it("defaults to dry-run when DRY_RUN env var is absent", async () => {
    setEnv("DRY_RUN", undefined);
    setEnv("ORG_ID", TEST_ORG_ID);

    await main(output);

    expect(pooledDb.artifact.deleteMany).not.toHaveBeenCalled();
    expect(txDb.artifact.deleteMany).not.toHaveBeenCalled();
    expect(getMockWithDb().tx).not.toHaveBeenCalled();
    expect(output.log).toHaveBeenCalledWith(
      expect.stringContaining("Phantom purge")
    );
    // The POOLED read, which builds the listing an operator reads before ever
    // setting DRY_RUN=0. It is scoped by the same `ORG_ID`, so dropping the
    // scope here would widen the preview across every organization while
    // deleting nothing — silent, and the reason a reviewer would approve the
    // destructive run that follows.
    const { fragment } = capturedOrgFilter(pooledDb.$queryRaw);
    expect(fragment.sql).toMatch(ORG_PREDICATE_SQL);
    expect(fragment.values).toEqual([TEST_ORG_ID]);
  });

  it("dry-run is true when DRY_RUN=1", async () => {
    setEnv("DRY_RUN", "1");
    setEnv("ORG_ID", TEST_ORG_ID);

    await main(output);

    expect(pooledDb.artifact.deleteMany).not.toHaveBeenCalled();
    expect(txDb.artifact.deleteMany).not.toHaveBeenCalled();
    expect(getMockWithDb().tx).not.toHaveBeenCalled();
  });

  // The script's own documented default invocation (neither var set). The guard
  // does not trip — `DRY_RUN` is true — so this is the unscoped PREVIEW, and the
  // point is that a preview stays a preview even with no org to scope it to.
  it("previews without deleting when DRY_RUN and ORG_ID are both unset", async () => {
    setEnv("DRY_RUN", undefined);
    setEnv("ORG_ID", undefined);

    await main(output);

    const { fragment } = capturedOrgFilter(pooledDb.$queryRaw);
    expect(fragment.sql).toBe("");
    expect(pooledDb.artifact.deleteMany).not.toHaveBeenCalled();
    expect(txDb.artifact.deleteMany).not.toHaveBeenCalled();
    expect(getMockWithDb().tx).not.toHaveBeenCalled();
  });

  // The positive control. Without it, a `DRY_RUN = true` mutation (never deletes)
  // would satisfy both cases above; with it, both mutation directions go red.
  it("dry-run is false only when DRY_RUN=0", async () => {
    setEnv("DRY_RUN", "0");
    setEnv("ORG_ID", TEST_ORG_ID);

    await main(output);

    expect(getMockWithDb().tx).toHaveBeenCalledOnce();
    // The TRANSACTION client's candidate, and only it. `main()` re-finds under
    // lock precisely so a session that gained token usage since the preview is
    // dropped, so deleting the POOLED rows would defeat the transaction while
    // looking identical from the outside. The two ids are what tell them apart.
    expect(txDb.artifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [TX_CANDIDATE_ID] } },
    });
    expect(pooledDb.artifact.deleteMany).not.toHaveBeenCalled();
    // The DESTRUCTIVE call site, not just the guard. Only the in-transaction
    // query's org predicate decides the blast radius, so it is read off the tx
    // client — which must have issued exactly that one find. Asserting the guard
    // merely read `ORG_ID` would leave `findPhantoms(tx, null)` — the scope
    // silently dropped between the guard and the delete — passing.
    expect(txDb.$queryRaw).toHaveBeenCalledOnce();
    const { fragment } = capturedOrgFilter(txDb.$queryRaw);
    expect(fragment.sql).toMatch(ORG_PREDICATE_SQL);
    expect(fragment.values).toEqual([TEST_ORG_ID]);
  });
});

describe("main — cross-org safety", () => {
  it("exits with error when DRY_RUN=0 and ORG_ID is unset", async () => {
    const savedDryRun = process.env.DRY_RUN;
    const savedOrgId = process.env.ORG_ID;
    // THROWS, rather than returning undefined. `process.exit` never returns in
    // production, so a no-op mock lets `main()` run ON past the guard it just
    // tripped — straight into `withDb`, which then demands real IAM credentials
    // (PGHOST/PGUSER/AWS_REGION/AWS_ROLE_ARN). That made a pure four-line env
    // check look like it needed a database: green in CI where the credentials
    // exist, red on a developer machine where they do not, and in neither case
    // exercising the path production actually takes.
    //
    // The direction matters: the no-op mock made everything after
    // `process.exit` REACHABLE here, when production can never reach it. So the
    // test exercised strictly more than the real thing, and could pass on
    // behaviour that never runs — the database access being exactly that. Same
    // shape as the seed entrypoint tests
    // (packages/database/scripts/seed/__tests__/unit).
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null | undefined
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    const deferred = createDeferredErrorOutput();

    try {
      process.env.DRY_RUN = "0";
      delete process.env.ORG_ID;

      // Asserting the REJECTION, not just the spy: `toHaveBeenCalledWith(1)`
      // alone passes for a mock that returns, which is the bug this replaces.
      const run = main(deferred.output);
      await Promise.resolve();

      expect(deferred.output.error).toHaveBeenCalledWith(
        expect.stringContaining("ORG_ID is required")
      );
      expect(exitSpy).not.toHaveBeenCalled();

      deferred.resolveError();

      await expect(run).rejects.toThrow("process.exit:1");

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      // `finally`, because the restore used to sit after an `await main()` that
      // threw on any machine without those credentials — leaking DRY_RUN=0 into
      // every test that ran after it.
      exitSpy.mockRestore();
      if (savedDryRun === undefined) {
        delete process.env.DRY_RUN;
      } else {
        process.env.DRY_RUN = savedDryRun;
      }
      if (savedOrgId === undefined) {
        delete process.env.ORG_ID;
      } else {
        process.env.ORG_ID = savedOrgId;
      }
    }
  });
});

const TEST_ORG_ID = "11111111-1111-4111-8111-111111111111";

/**
 * In execute mode `main()` finds twice: once pooled to build the preview, then
 * again INSIDE `withDb.tx` to re-find under lock. Only the second one's rows may
 * reach `deleteMany`, so the two clients hand back DIFFERENT ids and the id that
 * arrives at the delete identifies which read fed it.
 */
const POOLED_CANDIDATE_ID = "art-pooled";
const TX_CANDIDATE_ID = "art-tx";

const ORG_PREDICATE_SQL = /^AND\s+a\."organization_id"\s*=\s*\?::uuid$/;
const WHERE_CLAUSE_TAIL = /WHERE\s+tu\."id"\s+IS\s+NULL\s*$/;
const GROUP_BY_HEAD = /^\s*GROUP BY/;

/**
 * `$queryRaw` is a TAGGED TEMPLATE, so the mock records
 * `[templateStrings, ...interpolations]` and the org predicate is the single
 * interpolated `Prisma.Sql` fragment. A call-count assertion cannot distinguish
 * the two branches — both call `$queryRaw` exactly once — so the fragment, and
 * the template chunks surrounding it, are the only observables that differ.
 *
 * Which query is under inspection is decided by which CLIENT's `$queryRaw` is
 * passed, not by an index: the pooled preview and the in-transaction re-find sit
 * on separate mocks and do not carry the same authority.
 */
function capturedOrgFilter(queryRaw: Mock) {
  const call = queryRaw.mock.calls[0];
  if (call === undefined) {
    throw new Error("expected a $queryRaw call, got none");
  }
  const [strings, ...interpolations] = call as [
    readonly string[],
    ...unknown[],
  ];
  if (interpolations.length !== 1) {
    throw new Error(
      `expected exactly one interpolation, got ${interpolations.length}`
    );
  }
  const fragment = interpolations[0];
  if (!(fragment instanceof Prisma.Sql)) {
    throw new Error("expected the org filter to be a Prisma.Sql fragment");
  }
  return { before: strings[0], fragment, after: strings[1] };
}

function createMockDb(artifactId: string) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([mockCandidate({ artifactId })]),
    artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    // Assigning `undefined` would store the STRING "undefined".
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

function captureEnv(...keys: string[]) {
  const saved = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      setEnv(key, value);
    }
  };
}

function createMockOutput() {
  return {
    log: vi.fn(async (..._parts: unknown[]) => {}),
    warn: vi.fn(async (..._parts: unknown[]) => {}),
    error: vi.fn(async (..._parts: unknown[]) => {}),
  } satisfies ScriptOutput;
}

function createDeferredErrorOutput() {
  let resolveError: () => void;
  const errorPromise = new Promise<void>((resolve) => {
    resolveError = resolve;
  });
  const output = {
    log: vi.fn(async (..._parts: unknown[]) => {}),
    warn: vi.fn(async (..._parts: unknown[]) => {}),
    error: vi.fn(() => errorPromise),
  } satisfies ScriptOutput;
  return {
    output,
    resolveError: () => resolveError(),
  };
}

function failUnconfiguredTxMember(): never {
  throw new Error(
    "purgePhantoms reached a tx member this test did not configure"
  );
}
