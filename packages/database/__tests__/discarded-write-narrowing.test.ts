/**
 * ISS-6317 — the discarded-result Prisma writes in `packages/database` must not
 * ask Postgres for every column.
 *
 * Prisma's single-row `create`/`update`/`upsert` return the WHOLE row, so a write
 * whose result nobody reads still pays `RETURNING *`: every scalar column crosses
 * the wire and is materialised into a JS object that is dropped on the next line.
 * ISS-6227 measured that cost as per-CELL (≈270 B/cell), so a wide row is expensive
 * even when every column is short or NULL.
 *
 * THE PARITY RISK THIS FILE EXISTS TO PIN. The cheap-looking remedy — swapping
 * `update` for `updateMany` — is NOT semantics-preserving: `update` throws `P2025`
 * when the `where` matches nothing, while `updateMany` reports `{ count: 0 }` and
 * carries on. Turning a loud failure into a silent no-op is strictly worse than the
 * allocation it saves. So the conversion used here is `select` naming the model's
 * primary key, which narrows `RETURNING *` to one column while keeping every
 * single-row semantic, and the `absent row` blocks below pin that the throw still
 * escapes the production entry point. A conversion to `*Many` fails them.
 *
 * The two describes have different jobs and must be read as a pair:
 *   - `characterization` pins behavior that DID NOT CHANGE. It is deliberately blind
 *     to `select` and passed identically before and after the conversion.
 *   - `narrowing` pins the contract the conversion ADDED. It fails on unconverted
 *     source, which is what makes it a regression test rather than a restatement.
 *
 * Everything here runs against in-memory fakes — `packages/database` has no test
 * database wired up locally, and these contracts are about the ARGUMENTS the
 * production code hands Prisma, which need no engine to observe.
 */

import { describe, expect, it, vi } from "vitest";
import { seedCuratedCatalog } from "../prisma/seeds/catalog-seed";
import {
  type BackfillClient,
  runBackfill,
} from "../scripts/backfill-definition-versions";
import {
  type PackBackfillClient,
  runPackBackfill,
} from "../scripts/backfill-pack-definition-versions";
import { baselineContext } from "../scripts/seed/__tests__/fixtures/baseline-org";
import { createMockPrisma } from "../scripts/seed/__tests__/fixtures/mock-prisma";
import { type CoreSeedResult, seedCoreEntities } from "../scripts/seed/core";
import { seedCuratedCatalogItems } from "../scripts/seed/curated-catalog";
import { seedCustomizationEntities } from "../scripts/seed/customization";
import { seedEvaluationEntities } from "../scripts/seed/evaluation";
import { seedExecutionEntities } from "../scripts/seed/execution";
import { seedExtendedEntities } from "../scripts/seed/extended";
import { seedIntegrationEntities } from "../scripts/seed/integrations";
import { resetOrgData } from "../scripts/seed/reset";
import { EXPECTED_SEED_WRITE_FINGERPRINTS } from "./test-helpers/seed-write-fingerprints";

/**
 * The mock Prisma client is deliberately untyped at the delegate level — asserting
 * on `.mock.calls` through Prisma's fluent generics buys nothing and costs a cast
 * at every access.
 */
type AnyDelegate = any;

/** The single-row writes that return the full row unless told otherwise. */
const WIDE_WRITE_METHODS = ["create", "update", "upsert"] as const;
type WideWriteMethod = (typeof WIDE_WRITE_METHODS)[number];

/** One observed write: which delegate, which method, and the argument object. */
type RecordedWrite = {
  model: string;
  method: WideWriteMethod;
  args: Record<string, unknown>;
};

/**
 * Prisma error code for "an operation failed because it depends on one or more
 * records that were required but not found" — what a single-row `update`/`upsert`
 * raises when its `where` matches nothing, and precisely the signal a `*Many`
 * conversion would swallow.
 */
const RECORD_NOT_FOUND_CODE = "P2025";

/**
 * Set to `1` to print the fingerprint list this run observed, ready to paste into
 * `test-helpers/seed-write-fingerprints.ts`.
 *
 * The fixture is a snapshot of the DEFAULT seed profile's scale, so a retune of
 * that profile — nothing to do with ISS-6317 — moves hundreds of entries at once,
 * and every id is a v5 UUID no one can produce by hand. Without a mechanical way
 * back, the only recovery is to stop trusting the fixture, which is how a golden
 * gets regenerated blindly and stops being coverage at all.
 *
 * The assertion still runs under this flag. Regenerating therefore always costs a
 * visible, reviewable diff and can never be mistaken for a passing run.
 */
const FINGERPRINT_PRINT_ENV = "PRINT_SEED_WRITE_FINGERPRINTS";

function recordNotFoundError(): Error & { code: string } {
  const error = new Error(
    "An operation failed because it depends on one or more records that were required but not found."
  ) as Error & { code: string };
  error.code = RECORD_NOT_FOUND_CODE;
  return error;
}

/** Every delegate-shaped property on the mock client, keyed by model name. */
function delegateEntries(prisma: unknown): [string, AnyDelegate][] {
  return Object.entries(prisma as Record<string, AnyDelegate>).filter(
    ([, value]) =>
      value !== null &&
      typeof value === "object" &&
      typeof value.upsert === "function"
  );
}

/**
 * Stubs every delegate so a seed module can run end to end with no database:
 * lookups miss, and each write resolves to a row carrying whatever id the caller
 * asked for. Returning `{ id }` rather than a full row is faithful to the narrowed
 * shape and is also what the pre-existing seed unit tests already do.
 */
function buildResolvingMock() {
  const prisma = createMockPrisma();
  for (const [, delegate] of delegateEntries(prisma)) {
    delegate.findUnique.mockResolvedValue(null);
    delegate.findFirst.mockResolvedValue(null);
    delegate.findMany.mockResolvedValue([]);
    delegate.count.mockResolvedValue(0);
    for (const method of WIDE_WRITE_METHODS) {
      delegate[method].mockImplementation((args: AnyDelegate) =>
        Promise.resolve({
          id:
            args?.create?.id ??
            args?.data?.id ??
            args?.where?.id ??
            "fallback-id",
        })
      );
    }
    delegate.updateMany.mockResolvedValue({ count: 0 });
    delegate.deleteMany.mockResolvedValue({ count: 0 });
  }
  // `loop` is the seed's ONE cross-module read: `seedExtendedEntities` reads back
  // the loops `seedExecutionEntities` wrote and emits a LoopEvent per row. Under
  // the blanket empty `findMany` above that branch never runs, so its write would
  // be silently exempt from every assertion in this file — the write could lose
  // its `select` and nothing here would go red. Replaying the ids already upserted
  // on this same mock is what keeps that branch reachable. Inert until a loop
  // write has actually been recorded, so the single-module cases are unaffected.
  const loop = (prisma as AnyDelegate).loop;
  loop.findMany.mockImplementation((args: AnyDelegate) => {
    const rows = (loop.upsert.mock.calls as AnyDelegate[][]).map((call) => ({
      id: call[0]?.where?.id,
    }));
    return Promise.resolve(
      typeof args?.take === "number" ? rows.slice(0, args.take) : rows
    );
  });
  return prisma;
}

/** Harvests every `create`/`update`/`upsert` the production code issued. */
function recordedWrites(prisma: unknown): RecordedWrite[] {
  const writes: RecordedWrite[] = [];
  for (const [model, delegate] of delegateEntries(prisma)) {
    for (const method of WIDE_WRITE_METHODS) {
      for (const call of delegate[method].mock.calls as AnyDelegate[][]) {
        writes.push({
          model,
          method,
          args: (call[0] ?? {}) as Record<string, unknown>,
        });
      }
    }
  }
  return writes;
}

/**
 * A structural fingerprint of one write that deliberately EXCLUDES `select`, so
 * the characterization assertions below stay identical across the conversion. It
 * keeps the model, the method, the argument keys that decide what row is touched,
 * and the identity the write targets.
 */
function writeFingerprint(write: RecordedWrite): string {
  const keys = Object.keys(write.args)
    .filter((key) => key !== "select")
    .sort()
    .join("+");
  const where = write.args.where as { id?: string } | undefined;
  const create = write.args.create as { id?: string } | undefined;
  const data = write.args.data as { id?: string } | undefined;
  const identity = where?.id ?? create?.id ?? data?.id ?? "<none>";
  return `${write.model}.${write.method}(${keys}) id=${identity}`;
}

/**
 * Drives every seed module that owns an in-scope write, on one shared mock, in
 * the order `runSeedModules` (`scripts/seed/index.ts`) uses. The order is not
 * cosmetic: execution MUST precede extended, because extended's LoopEvent branch
 * reads back the loops execution wrote. Driving them the other way round leaves
 * that branch unreachable and quietly drops its write from every assertion here.
 */
async function driveSeedModules(): Promise<{
  prisma: ReturnType<typeof buildResolvingMock>;
  coreResult: CoreSeedResult;
}> {
  const prisma = buildResolvingMock();
  await seedCuratedCatalog(prisma as AnyDelegate);
  const coreResult = await seedCoreEntities(
    prisma as AnyDelegate,
    baselineContext
  );
  await seedExecutionEntities(
    prisma as AnyDelegate,
    baselineContext,
    coreResult
  );
  await seedIntegrationEntities(
    prisma as AnyDelegate,
    baselineContext,
    coreResult
  );
  await seedEvaluationEntities(
    prisma as AnyDelegate,
    baselineContext,
    coreResult
  );
  await seedCustomizationEntities(
    prisma as AnyDelegate,
    baselineContext,
    coreResult
  );
  await seedExtendedEntities(
    prisma as AnyDelegate,
    baselineContext,
    coreResult
  );
  // Not part of `runSeedModules`; its own entry point owns it. Order-independent
  // (global rows, no prerequisites), so it runs last rather than interleaved.
  await seedCuratedCatalogItems(prisma as AnyDelegate);
  return { prisma, coreResult };
}

// ---------------------------------------------------------------------------
// Backfill fakes. `BackfillClient` / `PackBackfillClient` are deliberately
// Prisma-generic-free, so a faithful fake is a few methods rather than a schema.
// ---------------------------------------------------------------------------

type BackfillRecorder = { writes: RecordedWrite[] };

/**
 * Whether the `SourceOccurrence` natural-key lookup finds a row. Both backfills
 * are find-then-write, so this selects which of the two in-scope writes the run
 * reaches: a miss drives `create`, a hit drives `update`.
 */
type OccurrenceLookup = { exists: boolean };

function makeBackfillClient(
  recorder: BackfillRecorder,
  lookup: OccurrenceLookup = { exists: false }
): BackfillClient {
  const record =
    (model: string, method: WideWriteMethod) => (args: AnyDelegate) => {
      recorder.writes.push({ model, method, args });
      return Promise.resolve({ id: "occurrence-1" });
    };
  return {
    agentComponentVersion: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "acv-1",
            organizationId: "org-1",
            componentKind: "agent",
            componentKey: "reviewer",
            source: "local",
            contentHash: "hash-1",
            content: "body",
            format: null,
            definitionVersionId: null,
          },
        ])
        .mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    definitionVersion: {
      upsert: vi.fn().mockResolvedValue({ id: "dv-1" }),
    },
    sourceOccurrence: {
      findFirst: vi
        .fn()
        .mockResolvedValue(lookup.exists ? { id: "occurrence-1" } : null),
      create: vi.fn().mockImplementation(record("sourceOccurrence", "create")),
      update: vi.fn().mockImplementation(record("sourceOccurrence", "update")),
    },
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as BackfillClient;
}

function makePackBackfillClient(
  recorder: BackfillRecorder,
  lookup: OccurrenceLookup = { exists: false }
): PackBackfillClient {
  const record =
    (model: string, method: WideWriteMethod) => (args: AnyDelegate) => {
      recorder.writes.push({ model, method, args });
      return Promise.resolve({ id: "occurrence-1" });
    };
  return {
    catalogItemVersion: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "civ-1",
            content: "body",
            definitionVersionId: null,
            catalogItem: {
              organizationId: "org-1",
              targetKind: "agent",
              parentPackId: "pack-1",
            },
          },
        ])
        .mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    definitionVersion: {
      upsert: vi.fn().mockResolvedValue({ id: "dv-1" }),
    },
    sourceOccurrence: {
      findFirst: vi
        .fn()
        .mockResolvedValue(lookup.exists ? { id: "occurrence-1" } : null),
      create: vi.fn().mockImplementation(record("sourceOccurrence", "create")),
      update: vi.fn().mockImplementation(record("sourceOccurrence", "update")),
    },
  } as unknown as PackBackfillClient;
}

// ---------------------------------------------------------------------------
// Characterization — behavior that must be IDENTICAL before and after ISS-6317.
// ---------------------------------------------------------------------------

describe("characterization: the writes packages/database issues", () => {
  it("seeds the same models, the same number of times, targeting the same ids", async () => {
    const { prisma } = await driveSeedModules();

    // Pinned per WRITE, not per model. A per-model count map supports the first
    // two clauses of this test's name and not the third: re-pointing a write at
    // a different row, swapping in another valid uuid, or changing the
    // `SEED_NAMESPACE` salt leaves every count identical. The fingerprint
    // carries the model, the method, the argument keys that decide which row is
    // touched, and the targeted id, so this single equality fails on a dropped,
    // added, duplicated, re-pointed, or re-salted seed write — and, carrying
    // model and method per entry, it pins the counts too. It omits `select`,
    // which is what keeps it unmoved by the ISS-6317 narrowing.
    const actual = recordedWrites(prisma).map(writeFingerprint).sort();

    if (process.env[FINGERPRINT_PRINT_ENV] === "1") {
      console.log(`\n${actual.join("\n")}\n`);
    }

    expect(actual).toEqual(EXPECTED_SEED_WRITE_FINGERPRINTS);
  });

  it("keeps every seeded upsert a single-row upsert with where/create/update", async () => {
    const { prisma } = await driveSeedModules();
    const upserts = recordedWrites(prisma).filter(
      (write) => write.method === "upsert"
    );

    expect(upserts.length).toBeGreaterThanOrEqual(40);
    for (const write of upserts) {
      expect(Object.keys(write.args)).toEqual(
        expect.arrayContaining(["where", "create", "update"])
      );
    }
  });

  it("scopes every seeded write it can to the baseline organization", async () => {
    const { prisma } = await driveSeedModules();
    const scoped = recordedWrites(prisma).filter((write) => {
      const create = write.args.create as
        | { organizationId?: string | null }
        | undefined;
      return create !== undefined && "organizationId" in create;
    });

    expect(scoped.length).toBeGreaterThan(0);
    for (const write of scoped) {
      const create = write.args.create as { organizationId?: string | null };
      // Curated catalog rows are deliberately global (null org); everything else
      // is baseline-scoped.
      expect([baselineContext.organizationId, null]).toContain(
        create.organizationId ?? null
      );
    }
  });

  // THE PARITY CASE. `resetOrgData` clears identity scalars with a single-row
  // `organization.update`; a missing org must still blow up rather than quietly
  // reporting success. This is exactly the assertion an `updateMany` conversion
  // breaks, and it is unchanged by the `select` conversion.
  it("propagates P2025 out of resetOrgData when the organization row is absent", async () => {
    const prisma = buildResolvingMock();
    const p = prisma as AnyDelegate;
    p.organization.update.mockRejectedValue(recordNotFoundError());

    await expect(
      resetOrgData(prisma as AnyDelegate, baselineContext.organizationId)
    ).rejects.toMatchObject({ code: RECORD_NOT_FOUND_CODE });
  });

  it("propagates P2025 out of the definition-version backfill when the occurrence row vanishes", async () => {
    const recorder: BackfillRecorder = { writes: [] };
    const client = makeBackfillClient(recorder, { exists: true });
    (client.sourceOccurrence.update as AnyDelegate).mockRejectedValue(
      recordNotFoundError()
    );

    await expect(
      runBackfill(client, { log: () => undefined })
    ).rejects.toMatchObject({ code: RECORD_NOT_FOUND_CODE });
  });

  it("propagates P2025 out of the pack backfill when the occurrence row vanishes", async () => {
    const recorder: BackfillRecorder = { writes: [] };
    const client = makePackBackfillClient(recorder, { exists: true });
    (client.sourceOccurrence.update as AnyDelegate).mockRejectedValue(
      recordNotFoundError()
    );

    await expect(
      runPackBackfill(client, { log: () => undefined })
    ).rejects.toMatchObject({ code: RECORD_NOT_FOUND_CODE });
  });

  it("propagates a failing seed upsert out of the seed module", async () => {
    const prisma = buildResolvingMock();
    const p = prisma as AnyDelegate;
    p.team.upsert.mockRejectedValue(recordNotFoundError());

    await expect(
      seedCoreEntities(prisma as AnyDelegate, baselineContext)
    ).rejects.toMatchObject({ code: RECORD_NOT_FOUND_CODE });
  });
});

// ---------------------------------------------------------------------------
// Narrowing — the contract ISS-6317 ADDED. Fails on unconverted source.
// ---------------------------------------------------------------------------

describe("narrowing: no discarded write returns every column", () => {
  /**
   * The one seed write ISS-6317 deliberately leaves alone. `seedCoreEntities`
   * READS the Team it upserts — `team.id` feeds the TeamMember upsert and the
   * returned `teamId` — so it is not a discarded write at all; the batch scan
   * that counted it was matching the callback shape, not the consumption. It is
   * named rather than filtered out by a predicate so that a future write which
   * IS discarded cannot slip through under the same exemption, and the companion
   * assertion below proves the result is genuinely consumed.
   */
  const CONSUMED_SEED_WRITE = "team.upsert";

  it("narrows every discarded seed-module write to the model primary key", async () => {
    const { prisma } = await driveSeedModules();
    const wide = recordedWrites(prisma).filter(
      (write) => write.args.select === undefined
    );

    expect(wide.map((write) => `${write.model}.${write.method}`)).toEqual([
      CONSUMED_SEED_WRITE,
    ]);
  });

  it("still consumes the one write it leaves un-narrowed", async () => {
    // The exemption is only legitimate while the RESOLVED row is actually read.
    // Proving that needs the write's OUTPUT to be distinguishable from its INPUT:
    // the default stub echoes `create.id` back, so an assertion against the call
    // args would hold even if the seed ignored the response entirely and reused
    // its own precomputed uuid. Resolving a sentinel id no caller could have
    // computed makes the read observable — if `core.ts` stops threading
    // `team.id` through, `coreResult.teamId` reverts to the deterministic uuid
    // and this fails.
    const prisma = buildResolvingMock();
    const p = prisma as AnyDelegate;
    const resolvedTeamId = "resolved-only-from-the-upsert-response";
    p.team.upsert.mockResolvedValue({ id: resolvedTeamId });

    const coreResult = await seedCoreEntities(
      prisma as AnyDelegate,
      baselineContext
    );

    const requestedTeamId = p.team.upsert.mock.calls[0][0].create.id as string;
    expect(requestedTeamId).not.toBe(resolvedTeamId);
    expect(coreResult.teamId).toBe(resolvedTeamId);
  });

  it("selects exactly the primary key, never a wider projection", async () => {
    const { prisma } = await driveSeedModules();
    const narrowed = recordedWrites(prisma).filter(
      (write) => write.args.select !== undefined
    );

    expect(narrowed.length).toBeGreaterThanOrEqual(40);
    for (const write of narrowed) {
      expect(write.args.select).toEqual({ id: true });
    }
  });

  it("narrows the definition-version backfill's occurrence create and update", async () => {
    const recorder: BackfillRecorder = { writes: [] };
    await runBackfill(makeBackfillClient(recorder, { exists: false }), {
      log: () => undefined,
    });
    await runBackfill(makeBackfillClient(recorder, { exists: true }), {
      log: () => undefined,
    });

    // Both branches of the find-then-write must have run, or this proves nothing.
    expect(recorder.writes.map((write) => write.method).sort()).toEqual([
      "create",
      "update",
    ]);
    for (const write of recorder.writes) {
      expect(write.args.select).toEqual({ id: true });
    }
  });

  it("narrows the pack backfill's occurrence create and update", async () => {
    const recorder: BackfillRecorder = { writes: [] };
    await runPackBackfill(makePackBackfillClient(recorder, { exists: false }), {
      log: () => undefined,
    });
    await runPackBackfill(makePackBackfillClient(recorder, { exists: true }), {
      log: () => undefined,
    });

    expect(recorder.writes.map((write) => write.method).sort()).toEqual([
      "create",
      "update",
    ]);
    for (const write of recorder.writes) {
      expect(write.args.select).toEqual({ id: true });
    }
  });

  it("narrows the organization update that resetOrgData discards", async () => {
    const prisma = buildResolvingMock();
    const p = prisma as AnyDelegate;

    await resetOrgData(prisma as AnyDelegate, baselineContext.organizationId);

    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true } })
    );
  });
});
