import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../scripts/db-utils";
import {
  defaultListMigrationDirs,
  type PreviewAtHeadDeps,
  previewPendingMigrations,
  probePreviewSchemaAtHead,
} from "../scripts/preview-at-head";
import { PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS } from "../scripts/preview-heavy-migrations";

const PREVIEW_SCHEMA = "preview_my_branch_abc12345";

// `_prisma_migrations` row shapes (node-postgres returns timestamptz as Date|null).
const appliedRow = (name: string) => ({
  migration_name: name,
  finished_at: new Date("2026-01-01T00:00:00Z"),
  rolled_back_at: null,
});
const unfinishedRow = (name: string) => ({
  migration_name: name,
  finished_at: null,
  rolled_back_at: null,
});
const rolledBackRow = (name: string) => ({
  migration_name: name,
  finished_at: new Date("2026-01-01T00:00:00Z"),
  rolled_back_at: new Date("2026-01-02T00:00:00Z"),
});

function makeClient(rows: Record<string, unknown>[]) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: SqlClient = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return Promise.resolve({ rows });
    }),
  };
  return { client, calls };
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

describe("previewPendingMigrations", () => {
  it("returns empty when every migration is applied", () => {
    expect(
      previewPendingMigrations(["a", "b"], new Set(["a", "b"]), new Set())
    ).toEqual([]);
  });

  it("returns the unapplied migrations", () => {
    expect(
      previewPendingMigrations(["a", "b", "c"], new Set(["a"]), new Set())
    ).toEqual(["b", "c"]);
  });

  it("treats a prestamp-skippable migration as satisfied even when unapplied", () => {
    // The perf-index skip-list migrations are pre-stamped (never built) on
    // preview, so an unapplied-but-skippable one must not count as pending.
    expect(
      previewPendingMigrations(["a", "skip"], new Set(["a"]), new Set(["skip"]))
    ).toEqual([]);
  });

  it("still flags a genuinely-pending migration alongside a skippable one", () => {
    expect(
      previewPendingMigrations(
        ["a", "skip", "new"],
        new Set(["a"]),
        new Set(["skip"])
      )
    ).toEqual(["new"]);
  });
});

describe("defaultListMigrationDirs", () => {
  it("reads the real prisma/migrations directory names from cwd", () => {
    // Regression guard for the deploy-time crash: the reader must resolve the
    // migrations dir from process.cwd() (not import.meta.dirname, which is
    // undefined under tsx's CJS transform and threw at module load). The db test
    // suite and the prebuild both run from packages/database.
    const dirs = defaultListMigrationDirs();
    expect(dirs.length).toBeGreaterThan(0);
    // Every skip-list entry is a real migration directory (asserted by the
    // preview-heavy-migrations suite), so the reader must surface it.
    expect(dirs).toContain(PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS[0]);
  });
});

describe("probePreviewSchemaAtHead", () => {
  const baseDeps = (
    over: {
      rows?: Record<string, unknown>[];
      dirs?: string[];
      createClient?: PreviewAtHeadDeps["createClient"];
      listMigrationDirs?: PreviewAtHeadDeps["listMigrationDirs"];
    } = {}
  ) => {
    const { client, calls } = makeClient(over.rows ?? []);
    const logger = makeLogger();
    const deps: PreviewAtHeadDeps = {
      createClient: over.createClient ?? (() => client),
      listMigrationDirs: over.listMigrationDirs ?? (() => over.dirs ?? []),
      logger,
    };
    return { deps, calls, logger };
  };

  it("returns false (no client) for the public schema", async () => {
    const createClient = vi.fn();
    const atHead = await probePreviewSchemaAtHead("postgres://x", "public", {
      createClient,
    });
    expect(atHead).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns false (no client) for a null schema", async () => {
    const createClient = vi.fn();
    const atHead = await probePreviewSchemaAtHead("postgres://x", null, {
      createClient,
    });
    expect(atHead).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("is at head when applied rows cover every non-skippable migration", async () => {
    const dirs = ["0001_a", "0002_b"];
    const { deps, calls } = baseDeps({
      dirs,
      rows: [appliedRow("0001_a"), appliedRow("0002_b")],
    });
    const atHead = await probePreviewSchemaAtHead(
      "postgres://x",
      PREVIEW_SCHEMA,
      deps
    );
    expect(atHead).toBe(true);
    // Schema-qualified read of the full row state (name + both timestamps, so
    // an unresolved row can be detected).
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain(`"${PREVIEW_SCHEMA}"."_prisma_migrations"`);
    expect(calls[0].text).toContain('"finished_at"');
    expect(calls[0].text).toContain('"rolled_back_at"');
  });

  it("is NOT at head when a migration directory has no applied row", async () => {
    const { deps } = baseDeps({
      dirs: ["0001_a", "0002_b"],
      rows: [appliedRow("0001_a")],
    });
    expect(
      await probePreviewSchemaAtHead("postgres://x", PREVIEW_SCHEMA, deps)
    ).toBe(false);
  });

  it("is at head when the only unapplied migration is a real skip-list entry", async () => {
    const skip = PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS[0];
    const { deps } = baseDeps({
      dirs: ["0001_a", skip],
      rows: [appliedRow("0001_a")],
    });
    expect(
      await probePreviewSchemaAtHead("postgres://x", PREVIEW_SCHEMA, deps)
    ).toBe(true);
  });

  it("is NOT at head when an unresolved (in-flight/failed) row exists even if every local migration is applied", async () => {
    // Kris Wong review: a started-but-unfinished row means Prisma still has work
    // (or a P3009 preview reset) to do; skipping migrate would leave partial DDL.
    const { deps } = baseDeps({
      dirs: ["0001_a"],
      rows: [appliedRow("0001_a"), unfinishedRow("0002_failed_unknown")],
    });
    expect(
      await probePreviewSchemaAtHead("postgres://x", PREVIEW_SCHEMA, deps)
    ).toBe(false);
  });

  it("does NOT count a rolled-back row as applied", async () => {
    const { deps } = baseDeps({
      dirs: ["0001_a"],
      rows: [rolledBackRow("0001_a")],
    });
    expect(
      await probePreviewSchemaAtHead("postgres://x", PREVIEW_SCHEMA, deps)
    ).toBe(false);
  });

  it("fails safe (not at head) on a malformed row shape", async () => {
    const { deps } = baseDeps({
      dirs: ["0001_a"],
      rows: [{ migration_name: 123 }],
    });
    expect(
      await probePreviewSchemaAtHead("postgres://x", PREVIEW_SCHEMA, deps)
    ).toBe(false);
  });

  it("fails open (false) and warns when the query throws (e.g. missing table)", async () => {
    const logger = makeLogger();
    const client: SqlClient = {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn(() =>
        Promise.reject(
          new Error('relation "_prisma_migrations" does not exist')
        )
      ),
    };
    const atHead = await probePreviewSchemaAtHead(
      "postgres://x",
      PREVIEW_SCHEMA,
      {
        createClient: () => client,
        listMigrationDirs: () => ["0001_a"],
        logger,
      }
    );
    expect(atHead).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Still closes the connection on the error path.
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("fails open (false) when there are no migration directories to compare", async () => {
    const createClient = vi.fn();
    const atHead = await probePreviewSchemaAtHead(
      "postgres://x",
      PREVIEW_SCHEMA,
      {
        createClient,
        listMigrationDirs: () => [],
      }
    );
    expect(atHead).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("connects and closes exactly once on the success path", async () => {
    const { client } = makeClient([appliedRow("0001_a")]);
    await probePreviewSchemaAtHead("postgres://x", PREVIEW_SCHEMA, {
      createClient: () => client,
      listMigrationDirs: () => ["0001_a"],
    });
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
