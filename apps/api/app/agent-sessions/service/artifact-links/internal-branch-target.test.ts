import { describe, expect, it, vi } from "vitest";
import type { AgentSessionUpsertTx } from "../records";
import { bindParameterChunkSize } from "../write-chunking";
import { ensureInternalBranchActivityTargets } from "./internal-branch-target";
import type { SessionBranchRepositoryAuthority } from "./shared";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const REPO_FULL_NAME = "acme/web";
// Branch names whose two collations DISAGREE, which is the only shape where
// sorting the lock keys is observable at all. The dedupe above the lock orders
// targets with `localeCompare`, which is case-insensitive at primary strength
// and yields [alpha, Zeta]; the lock keys are ordered by `Array#sort`, which is
// raw UTF-16 and puts "Z" (0x5a) before "a" (0x61), yielding [Zeta, alpha].
// Same-case names collate identically under both, so a fixture built from them
// cannot fail no matter what the production code does.
const UPPER_BRANCH = "Zeta";
const LOWER_BRANCH = "alpha";

const RESOLVED_AUTHORITY: SessionBranchRepositoryAuthority = {
  repositoryId: null,
  authorities: [],
  identitySources: new Set(),
};
/** Two binds per target beside the org bind, as the lookup declares it. */
const LOOKUP_CHUNK = bindParameterChunkSize(2, 1);
/** Every column of `model Artifact` / `model BranchDetail`, as the writer counts. */
const ARTIFACT_INSERT_CHUNK = bindParameterChunkSize(17, 0);
const BRANCH_DETAIL_INSERT_CHUNK = bindParameterChunkSize(50, 0);

/**
 * ISS-8780 — the lock ACQUISITION SEQUENCE, which the DB-backed sibling suite
 * cannot see.
 *
 * Sorted keys taken one statement at a time are what stop two concurrent ingest
 * transactions from holding each other's keys, and that property lives entirely
 * in the shape of the calls: a real-Postgres test observes only the rows that
 * result, so it passes just as happily against an unsorted batch. A transaction
 * double is the only thing that can watch the statements go by.
 *
 * This deliberately does NOT assert the void-deserialization regression — a
 * double resolves `$executeRaw` and `$queryRaw` alike, so it could not fail on
 * it. That half is the integration suite's, and only its.
 */
describe("internal branch activity target lock acquisition (ISS-8780)", () => {
  it("takes one lock per key, in lock-key order, ahead of the writes", async () => {
    // Guards the fixture itself: if these two ever collate the same way, the
    // ordering assertion below silently stops testing anything.
    expect(
      [UPPER_BRANCH, LOWER_BRANCH].sort()[0] ===
        [UPPER_BRANCH, LOWER_BRANCH].sort((left, right) =>
          left.localeCompare(right)
        )[0]
    ).toBe(false);

    const { tx, executeRaw, order } = buildTxDouble();

    await ensureInternalBranchActivityTargets(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: null,
      targets: [
        branchTarget(REPO_FULL_NAME, LOWER_BRANCH),
        branchTarget(REPO_FULL_NAME, UPPER_BRANCH),
      ],
    });

    const lockKeys = executeRaw.mock.calls.map((call) => call[1] as string);
    // One statement per key: a single batched acquisition lands as one call.
    expect(lockKeys).toHaveLength(2);
    // Lock-key order, NOT the identity order the targets were sorted into.
    expect(lockKeys[0].endsWith(`:${UPPER_BRANCH}`)).toBe(true);
    expect(lockKeys[1].endsWith(`:${LOWER_BRANCH}`)).toBe(true);
    for (const call of executeRaw.mock.calls) {
      expect((call[0] as readonly string[]).join("")).toContain(
        "pg_advisory_xact_lock"
      );
    }
    // Locks first: an acquisition after the recheck protects nothing.
    expect(order.indexOf("branchDetail.findMany")).toBeGreaterThan(
      order.lastIndexOf("$executeRaw")
    );
  });
});

/**
 * ISS-9860 — nothing bounds how many distinct Branch targets one Session's
 * monitored activity names, so every per-target statement here is sliced at
 * the bind budget: one over the widest single statement must cost a second
 * statement, never a refused one.
 */
describe("internal branch activity target materialization width (ISS-9860)", () => {
  it("splits the recheck, both inserts, and the re-read at the bind budget for more targets than one statement holds", async () => {
    const targetCount = LOOKUP_CHUNK + 1;
    const { tx, findMany, artifactCreateMany, branchDetailCreateMany } =
      buildWideTxDouble();

    const resolved = await ensureInternalBranchActivityTargets(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: null,
      targets: Array.from({ length: targetCount }, (_, index) =>
        branchTarget(REPO_FULL_NAME, `feat/wide-${index}`)
      ),
    });

    // The recheck before the inserts and the re-read after them, each per chunk.
    const readChunks = Math.ceil(targetCount / LOOKUP_CHUNK);
    expect(findMany).toHaveBeenCalledTimes(2 * readChunks);
    for (const [args] of findMany.mock.calls) {
      expect(args.where.OR.length).toBeLessThanOrEqual(LOOKUP_CHUNK);
    }
    expect(artifactCreateMany).toHaveBeenCalledTimes(
      Math.ceil(targetCount / ARTIFACT_INSERT_CHUNK)
    );
    for (const [args] of artifactCreateMany.mock.calls) {
      expect(args.data.length).toBeLessThanOrEqual(ARTIFACT_INSERT_CHUNK);
    }
    expect(branchDetailCreateMany).toHaveBeenCalledTimes(
      Math.ceil(targetCount / BRANCH_DETAIL_INSERT_CHUNK)
    );
    for (const [args] of branchDetailCreateMany.mock.calls) {
      expect(args.data.length).toBeLessThanOrEqual(BRANCH_DETAIL_INSERT_CHUNK);
    }
    // Every target resolves to the artifact this transaction minted for it.
    expect(resolved.size).toBe(targetCount);
    const minted = new Set(
      branchDetailCreateMany.mock.calls.flatMap(([args]) =>
        args.data.map((row) => row.artifactId)
      )
    );
    expect(minted.size).toBe(targetCount);
    for (const artifactId of resolved.values()) {
      expect(minted.has(artifactId)).toBe(true);
    }
  });
});

function branchTarget(repositoryFullName: string, branchName: string) {
  return {
    repositoryAuthority: RESOLVED_AUTHORITY,
    repositoryFullName,
    branchName,
  };
}

function buildTxDouble() {
  const order: string[] = [];
  let created: {
    artifactId: string;
    repositoryFullName: string;
    branchName: string;
  }[] = [];
  // Parameters typed so `mock.calls` is indexable: `vi.fn(() => …)` infers a
  // zero-length argument tuple and `call[1]` then fails to compile.
  const executeRaw = vi.fn((..._args: unknown[]) => {
    order.push("$executeRaw");
    return Promise.resolve(0);
  });
  const findMany = vi.fn(() => {
    order.push("branchDetail.findMany");
    // First call is the recheck (nothing exists yet); later calls are the
    // post-insert re-read, which sees whatever was written.
    return Promise.resolve(
      order.includes("branchDetail.createMany") ? created : []
    );
  });
  const tx = {
    $executeRaw: executeRaw,
    artifact: {
      createMany: vi.fn(() => Promise.resolve({ count: created.length })),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
    branchDetail: {
      findMany,
      createMany: vi.fn((args: { data: typeof created }) => {
        order.push("branchDetail.createMany");
        created = args.data.map((row) => ({
          artifactId: row.artifactId,
          repositoryFullName: row.repositoryFullName,
          branchName: row.branchName,
        }));
        return Promise.resolve({ count: created.length });
      }),
    },
  } as unknown as AgentSessionUpsertTx;
  return { tx, executeRaw, order };
}

type CreatedBranchDetailRow = {
  artifactId: string;
  repositoryFullName: string;
  branchName: string;
};

/**
 * A double whose re-read answers by identity rather than "whatever the last
 * insert wrote", so a chunked insert followed by a chunked re-read reconciles
 * every row and not only the final slice's.
 */
function buildWideTxDouble() {
  const createdByIdentity = new Map<string, CreatedBranchDetailRow>();
  const findMany = vi.fn(
    (args: {
      where: { OR: { repositoryFullName: string; branchName: string }[] };
    }) =>
      Promise.resolve(
        args.where.OR.flatMap((arm) => {
          const row = createdByIdentity.get(
            `${arm.repositoryFullName}\u0000${arm.branchName}`
          );
          return row ? [row] : [];
        })
      )
  );
  const artifactCreateMany = vi.fn((args: { data: { id: string }[] }) =>
    Promise.resolve({ count: args.data.length })
  );
  const branchDetailCreateMany = vi.fn(
    (args: { data: CreatedBranchDetailRow[] }) => {
      for (const row of args.data) {
        createdByIdentity.set(
          `${row.repositoryFullName}\u0000${row.branchName}`,
          {
            artifactId: row.artifactId,
            repositoryFullName: row.repositoryFullName,
            branchName: row.branchName,
          }
        );
      }
      return Promise.resolve({ count: args.data.length });
    }
  );
  const tx = {
    $executeRaw: vi.fn((..._args: unknown[]) => Promise.resolve(0)),
    artifact: {
      createMany: artifactCreateMany,
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
    branchDetail: { findMany, createMany: branchDetailCreateMany },
  } as unknown as AgentSessionUpsertTx;
  return { tx, findMany, artifactCreateMany, branchDetailCreateMany };
}
