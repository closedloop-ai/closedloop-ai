/**
 * @file prisma-sqlite-adapter.test.ts
 * @description Exercises the generated Prisma client over the libSQL adapter
 * (@prisma/adapter-libsql) against the real desktop schema. Covers the sharp
 * edges from FEA-1736 area 4: interactive transactions, serialization with
 * concurrent queries, JSON round-trips, BigInt/REAL type mapping, and
 * dbgenerated defaults — now on the SQLite substrate.
 *
 * The Prisma client used here is generated from prisma/schema.prisma into
 * src/main/database/generated (gitignored) — `pnpm test` runs
 * `prisma generate` via the pretest hook.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/baseline-schema.js";
import { PrismaClient } from "../src/main/database/generated/client.js";
import { openLibsqlDatabase } from "../src/main/database/libsql-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migrations-manifest.js";

const FORCED_ROLLBACK_RE = /forced rollback/;

async function createClient(): Promise<{
  prisma: PrismaClient;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prisma-adapter-"));
  // Open the libSQL DB and run the same migration path used at boot so the
  // generated Prisma client sees the current schema. The raw `db` handle drives
  // migrations; the Prisma adapter opens its own connection from `config`.
  const { db, config } = await openLibsqlDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const adapter = new PrismaLibSql(config);
  const prisma = new PrismaClient({ adapter });
  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("CRUD round-trip on sessions through the generated client", async () => {
  const { prisma, close } = await createClient();
  try {
    await prisma.session.create({
      data: {
        id: "ses-1",
        name: "first",
        status: "running",
        harness: "claude",
        startedAt: "2026-06-12T00:00:00.000Z",
      },
    });
    const found = await prisma.session.findUnique({ where: { id: "ses-1" } });
    assert.equal(found?.name, "first");
    assert.equal(found?.status, "running");

    await prisma.session.update({
      where: { id: "ses-1" },
      data: { status: "completed" },
    });
    const updated = await prisma.session.findUnique({ where: { id: "ses-1" } });
    assert.equal(updated?.status, "completed");

    const count = await prisma.session.count();
    assert.equal(count, 1);
  } finally {
    await close();
  }
});

test("relation queries traverse the agents foreign key", async () => {
  const { prisma, close } = await createClient();
  try {
    await prisma.session.create({
      data: {
        id: "ses-rel",
        agents: {
          create: [
            { id: "agent-1", status: "running" },
            { id: "agent-2", status: "completed" },
          ],
        },
      },
    });
    const withAgents = await prisma.session.findUnique({
      where: { id: "ses-rel" },
      include: { agents: true },
    });
    assert.equal(withAgents?.agents.length, 2);

    // ON DELETE CASCADE comes from the schema, not client-side emulation.
    await prisma.session.delete({ where: { id: "ses-rel" } });
    const orphans = await prisma.agent.count();
    assert.equal(orphans, 0);
  } finally {
    await close();
  }
});

test("interactive transaction commits atomically and rolls back on throw", async () => {
  const { prisma, close } = await createClient();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.session.create({ data: { id: "ses-tx" } });
      await tx.agent.create({ data: { id: "agent-tx", sessionId: "ses-tx" } });
    });
    assert.equal(await prisma.agent.count(), 1);

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.session.create({ data: { id: "ses-rollback" } });
        throw new Error("forced rollback");
      }),
      FORCED_ROLLBACK_RE
    );
    const rolledBack = await prisma.session.findUnique({
      where: { id: "ses-rollback" },
    });
    assert.equal(rolledBack, null);
  } finally {
    await close();
  }
});

// SQLite is a single-connection database. The FEA-1736 sharp edge: a query
// issued while an interactive transaction is open must queue, not deadlock the
// process. This is the property the Phase 3 write-queue rule protects; here we
// prove the substrate behaves. The explicit timeout makes a deadlock regression
// fail deterministically rather than hang until the CI job timeout.
test("concurrent query during an open interactive transaction does not deadlock", {
  timeout: 30_000,
}, async () => {
  const { prisma, close } = await createClient();
  try {
    // Fire-and-observe: a non-transactional query racing the open transaction.
    // Intentionally not awaited inside the transaction — with a single
    // connection it can only complete after commit, when it must see the one
    // committed row.
    let concurrent: Promise<number> = Promise.resolve(-1);
    await prisma.$transaction(async (tx) => {
      await tx.session.create({ data: { id: "ses-conc" } });
      concurrent = prisma.session.count();
      await tx.session.update({
        where: { id: "ses-conc" },
        data: { name: "updated-in-tx" },
      });
    });
    const finalCount = await prisma.session.count();
    assert.equal(finalCount, 1);
    const concurrentCount = await raceWithDeadline(
      concurrent,
      10_000,
      "queued query did not complete after commit — adapter deadlock"
    );
    // Strict: proves the queued read observed the committed transaction (post-
    // commit ordering), not merely that it resolved. A read that slipped in
    // before commit would see 0 and fail here.
    assert.equal(
      concurrentCount,
      1,
      "queued query must observe the committed row after commit"
    );
  } finally {
    await close();
  }
});

test("JSONB columns round-trip structured values", async () => {
  const { prisma, close } = await createClient();
  try {
    const harnesses = ["claude", "codex"];
    const installCommands = {
      claude: ["claude plugin add x"],
      nested: { a: 1 },
    };
    await prisma.packCatalog.create({
      data: {
        packId: "pack-1",
        displayName: "Pack One",
        githubUrl: "https://github.com/example/pack-one",
        harnesses,
        installCommands,
      },
    });
    const row = await prisma.packCatalog.findUnique({
      where: { packId: "pack-1" },
    });
    assert.deepEqual(row?.harnesses, harnesses);
    assert.deepEqual(row?.installCommands, installCommands);
  } finally {
    await close();
  }
});

test("BigInt and REAL columns round-trip with correct types", async () => {
  const { prisma, close } = await createClient();
  try {
    const mtime = 1781200000123n;
    // FEA-1899: pr_backfill_seen folded away; artifact_link_backfill_seen keeps
    // the BigInt file_mtime_ms column this round-trip exercises.
    await prisma.session.create({ data: { id: "ses-big" } });
    await prisma.artifactLinkBackfillSeen.create({
      data: { sessionId: "ses-big", fileMtimeMs: mtime, extractorVersion: 1 },
    });
    const seen = await prisma.artifactLinkBackfillSeen.findUnique({
      where: { sessionId: "ses-big" },
    });
    assert.equal(seen?.fileMtimeMs, mtime);

    await prisma.plan.create({ data: { id: "plan-1", confidence: 0.5 } });
    const plan = await prisma.plan.findUnique({ where: { id: "plan-1" } });
    assert.equal(plan?.confidence, 0.5);
  } finally {
    await close();
  }
});

test("dbgenerated default fills token_usage.created_at", async () => {
  const { prisma, close } = await createClient();
  try {
    await prisma.tokenUsage.create({
      data: { sessionId: "ses-tok", model: "claude-fable-5", inputTokens: 10 },
    });
    const row = await prisma.tokenUsage.findUnique({
      where: {
        sessionId_model: { sessionId: "ses-tok", model: "claude-fable-5" },
      },
    });
    assert.ok(row?.createdAt, "created_at should be set by the DB default");
  } finally {
    await close();
  }
});

test("$queryRaw escape hatch works for analytical SQL", async () => {
  const { prisma, close } = await createClient();
  try {
    await prisma.session.create({ data: { id: "ses-raw", status: "running" } });
    // libSQL returns COUNT(*) as a JS number (SQLite returned a Postgres
    // bigint); the raw-read escape hatch surfaces that engine-native type.
    const rows = await prisma.$queryRaw<
      { status: string; n: number }[]
    >`SELECT status, count(*) AS n FROM sessions GROUP BY status`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "running");
    assert.equal(Number(rows[0].n), 1);
  } finally {
    await close();
  }
});

// The plan-store write path runs its verbatim hand-tuned SQL through the
// `*Unsafe` raw variants with $N positional params (not tagged-template
// `$queryRaw`). Characterize both directly against the adapter so a future
// adapter swap (FEA-1736 in-house SqlDriverAdapter) is validated for the exact
// methods that path depends on, independent of plan-store.
test("$queryRawUnsafe / $executeRawUnsafe work with positional params", async () => {
  const { prisma, close } = await createClient();
  try {
    // $executeRawUnsafe mutates and returns the affected-row count.
    const inserted = await prisma.$executeRawUnsafe(
      "INSERT INTO sessions (id, status) VALUES ($1, $2)",
      "ses-unsafe",
      "running"
    );
    assert.equal(inserted, 1);

    // $queryRawUnsafe reads back via a positional param.
    const rows = await prisma.$queryRawUnsafe<{ id: string; status: string }[]>(
      "SELECT id, status FROM sessions WHERE id = $1",
      "ses-unsafe"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "ses-unsafe");
    assert.equal(rows[0].status, "running");

    // Zero affected rows when nothing matches — this is the signal plan-store's
    // confirm/reject ("did a row match?") and dedup paths rely on.
    const noMatch = await prisma.$executeRawUnsafe(
      "UPDATE sessions SET status = $1 WHERE id = $2",
      "done",
      "nonexistent"
    );
    assert.equal(noMatch, 0);
  } finally {
    await close();
  }
});

function raceWithDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
