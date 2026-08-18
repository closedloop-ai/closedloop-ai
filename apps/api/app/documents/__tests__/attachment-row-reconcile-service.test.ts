/**
 * Unit tests for attachmentRowReconcileService — the DB-row side of the
 * attachment reconcile pair. This sweep DELETES rows, so the tests drive the
 * safety properties directly rather than asserting call shapes:
 *
 * The `fileAttachment` double holds synthetic rows and genuinely evaluates the
 * `createdAt < cutoff` predicate, the reconcile-ledger predicates, the ordering,
 * the page size, and the `deleteMany` filter, so "a just-created row is
 * protected" is proven by that row surviving a real run — not by inspecting the
 * arguments Prisma was called with. It also models Prisma cursor pagination
 * faithfully (a cursor row deleted before it is used yields an empty page), so a
 * sweep that paged by cursor over rows it deletes cannot pass the page-boundary
 * test below.
 *
 * Covered:
 *   - a systemic bucket failure aborts the run instead of classifying rows
 *   - absence must be observed by TWO runs before a row can be deleted
 *   - an upload that lands between the two observations clears the mark
 *   - the upload-window cutoff protects a just-created row (never even checked)
 *   - an ambiguous S3 failure marks nothing and deletes nothing
 *   - the sweep reaches rows behind the first page, across runs and within one
 *   - a truncated survey says so; a complete one says that too
 *   - the per-run deletion cap holds, and a nonsense cap is clamped
 *   - dry-run (the default) reports the blast radius and deletes nothing
 *   - a missing bucket short-circuits to a successful no-op
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/aws", () => ({
  headAttachmentObject: vi.fn(),
  headAttachmentsBucket: vi.fn(),
}));

vi.mock("@repo/aws/keys", () => ({
  keys: vi.fn(() => ({ FILE_ATTACHMENTS_BUCKET: "test-bucket" })),
}));

type StoredRow = {
  id: string;
  key: string;
  bucket: string;
  createdAt: Date;
  reconciledAt: Date;
  reconcileAbsent: boolean;
};

let storedRows: StoredRow[] = [];

type RowWhere = {
  bucket?: string;
  createdAt?: { lt: Date };
  reconcileAbsent?: boolean;
  reconciledAt?: { lt: Date };
  id?: { in: string[] };
};

type OrderBySpec = Record<string, "asc" | "desc">;

type FindManyArgs = {
  where: RowWhere;
  take: number;
  orderBy: OrderBySpec | OrderBySpec[];
  cursor?: { id: string };
  skip?: number;
};

type UpdateManyArgs = {
  where: RowWhere;
  data: { reconciledAt: Date; reconcileAbsent?: boolean };
};

type DeleteManyArgs = { where: RowWhere };

function matches(row: StoredRow, where: RowWhere): boolean {
  if (where.bucket !== undefined && row.bucket !== where.bucket) {
    return false;
  }
  if (where.createdAt !== undefined && !(row.createdAt < where.createdAt.lt)) {
    return false;
  }
  if (
    where.reconcileAbsent !== undefined &&
    row.reconcileAbsent !== where.reconcileAbsent
  ) {
    return false;
  }
  if (
    where.reconciledAt !== undefined &&
    !(row.reconciledAt < where.reconciledAt.lt)
  ) {
    return false;
  }
  if (where.id !== undefined && !where.id.in.includes(row.id)) {
    return false;
  }
  return true;
}

function sortKey(row: StoredRow, field: string): string | number {
  return field === "id" ? row.id : row.reconciledAt.getTime();
}

function compareKeys(left: string | number, right: string | number): number {
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }
  return Number(left) - Number(right);
}

function compareBy(
  orderBy: OrderBySpec | OrderBySpec[]
): (a: StoredRow, b: StoredRow) => number {
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return (a, b) => {
    for (const spec of specs) {
      for (const [field, direction] of Object.entries(spec)) {
        const ordered = compareKeys(sortKey(a, field), sortKey(b, field));
        if (ordered !== 0) {
          return direction === "asc" ? ordered : -ordered;
        }
      }
    }
    return 0;
  };
}

const findMany = vi.fn((args: FindManyArgs) => {
  let matched = storedRows
    .filter((row) => matches(row, args.where))
    .sort(compareBy(args.orderBy));

  if (args.cursor) {
    // Prisma resolves the cursor against a row that must still exist; a cursor
    // row deleted before this read yields an empty page.
    const index = matched.findIndex((row) => row.id === args.cursor?.id);
    matched = index === -1 ? [] : matched.slice(index + (args.skip ?? 0));
  }

  return Promise.resolve(
    matched.slice(0, args.take).map((row) => ({ id: row.id, key: row.key }))
  );
});

const updateMany = vi.fn((args: UpdateManyArgs) => {
  let count = 0;
  for (const row of storedRows) {
    if (!matches(row, args.where)) {
      continue;
    }
    row.reconciledAt = args.data.reconciledAt;
    if (args.data.reconcileAbsent !== undefined) {
      row.reconcileAbsent = args.data.reconcileAbsent;
    }
    count += 1;
  }
  return Promise.resolve({ count });
});

const deleteMany = vi.fn((args: DeleteManyArgs) => {
  const before = storedRows.length;
  storedRows = storedRows.filter((row) => !matches(row, args.where));
  return Promise.resolve({ count: before - storedRows.length });
});

vi.mock("@repo/database", () => ({
  withDb: vi.fn((cb: (db: unknown) => unknown) =>
    cb({ fileAttachment: { findMany, updateMany, deleteMany } })
  ),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../attachments-service", () => ({
  ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS: 900,
}));

import { headAttachmentObject, headAttachmentsBucket } from "@repo/aws";
import { keys as awsKeys } from "@repo/aws/keys";
import { attachmentRowReconcileService } from "../attachment-row-reconcile-service";

const NOW = new Date("2026-08-10T12:00:00.000Z");
/** Comfortably older than NOW − 900s, so these rows are past the upload window. */
const OLD = new Date("2026-08-01T00:00:00.000Z");
/** Inside the 900s presigned-upload window — an upload may still be in flight. */
const JUST_CREATED = new Date(NOW.getTime() - 60_000);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const PRESENT_OBJECT = { byteSize: 12, etag: '"abc"' };

function seedRows(...rows: StoredRow[]): void {
  storedRows = [...rows];
}

function row(id: string, createdAt: Date): StoredRow {
  return {
    id,
    key: `attachments/org/doc/${id}`,
    bucket: "test-bucket",
    createdAt,
    // Mirrors the column default: a row starts unexamined by the sweep.
    reconciledAt: createdAt,
    reconcileAbsent: false,
  };
}

/** Routes each key to "present", "absent" (404), or a thrown S3 failure. */
function headResolvesBy(
  states: Record<string, "present" | "absent" | "error">
) {
  vi.mocked(headAttachmentObject).mockImplementation((key: string) => {
    const state = states[key];
    if (state === "error") {
      return Promise.reject(new Error("ServiceUnavailable"));
    }
    return Promise.resolve(state === "absent" ? null : PRESENT_OBJECT);
  });
}

/** Every seeded row's object is absent. */
function headResolvesAllAbsent() {
  vi.mocked(headAttachmentObject).mockResolvedValue(null);
}

function remainingIds(): string[] {
  return storedRows.map((r) => r.id).sort();
}

/** Advances the clock a full day — the sweep runs nightly. */
function advanceOneDay(): void {
  vi.setSystemTime(new Date(Date.now() + ONE_DAY_MS));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  storedRows = [];
  vi.mocked(headAttachmentsBucket).mockResolvedValue(undefined);
  vi.mocked(awsKeys).mockReturnValue({
    FILE_ATTACHMENTS_BUCKET: "test-bucket",
  } as ReturnType<typeof awsKeys>);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("attachmentRowReconcileService bucket probe", () => {
  it("aborts the run without classifying any row when the bucket is inaccessible", async () => {
    // The catastrophic case: a deleted or misconfigured bucket answers every
    // HeadObject with a 404 that looks exactly like a missing key, so without
    // this probe an armed run would classify the whole table as orphaned.
    seedRows(row("orphan", OLD), row("healthy", OLD));
    headResolvesAllAbsent();
    vi.mocked(headAttachmentsBucket).mockRejectedValue(
      Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" })
    );

    const result = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(remainingIds()).toEqual(["healthy", "orphan"]);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(headAttachmentObject).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.scanned).toBe(0);
    expect(result.newlyAbsent).toBe(0);
    expect(result.orphansDeleted).toBe(0);
    expect(result.summary).toContain("not accessible");
  });

  it("probes the bucket before reading any row", async () => {
    seedRows(row("orphan", OLD));
    headResolvesAllAbsent();

    await attachmentRowReconcileService.runRowReconcileSweep({ apply: true });

    expect(headAttachmentsBucket).toHaveBeenCalledWith("test-bucket");
    expect(
      vi.mocked(headAttachmentsBucket).mock.invocationCallOrder[0]
    ).toBeLessThan(findMany.mock.invocationCallOrder[0]);
  });
});

describe("attachmentRowReconcileService two-observation boundary", () => {
  it("marks a first-observed absent row and deletes nothing on that run", async () => {
    // A presigned PUT's expiry gates when the transfer may start, not how long
    // it may run, so one 404 is not proof the upload was abandoned.
    seedRows(row("orphan", OLD));
    headResolvesAllAbsent();

    const result = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(remainingIds()).toEqual(["orphan"]);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(storedRows[0].reconcileAbsent).toBe(true);
    expect(result.newlyAbsent).toBe(1);
    expect(result.orphansConfirmed).toBe(0);
    expect(result.orphansDeleted).toBe(0);
  });

  it("deletes the row once a later run observes the same absence", async () => {
    seedRows(row("orphan", OLD), row("healthy", OLD));
    headResolvesBy({
      "attachments/org/doc/orphan": "absent",
      "attachments/org/doc/healthy": "present",
    });

    await attachmentRowReconcileService.runRowReconcileSweep({ apply: true });
    advanceOneDay();
    const second = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(second.orphansConfirmed).toBe(1);
    expect(second.orphansDeleted).toBe(1);
    expect(second.newlyAbsent).toBe(0);
    expect(remainingIds()).toEqual(["healthy"]);
  });

  it("clears the mark instead of deleting when the upload lands between the two observations", async () => {
    // The exact race the boundary exists for: still transferring during the
    // first HeadObject, complete by the second.
    seedRows(row("slow-upload", OLD));
    headResolvesBy({ "attachments/org/doc/slow-upload": "absent" });

    await attachmentRowReconcileService.runRowReconcileSweep({ apply: true });
    headResolvesBy({ "attachments/org/doc/slow-upload": "present" });
    advanceOneDay();
    const second = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(second.recovered).toBe(1);
    expect(second.orphansDeleted).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(remainingIds()).toEqual(["slow-upload"]);
    expect(storedRows[0].reconcileAbsent).toBe(false);
  });

  it("does not confirm a mark younger than the confirmation gap", async () => {
    // Same two runs as the deleting case above, only closer together: a second
    // run minutes after the first is not an independent observation.
    seedRows(row("orphan", OLD));
    headResolvesAllAbsent();

    await attachmentRowReconcileService.runRowReconcileSweep({ apply: true });
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const second = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(second.orphansConfirmed).toBe(0);
    expect(second.orphansDeleted).toBe(0);
    expect(remainingIds()).toEqual(["orphan"]);
  });
});

describe("attachmentRowReconcileService candidate selection", () => {
  it("never considers a row created inside the upload window", async () => {
    seedRows(row("fresh", JUST_CREATED));
    // Would be marked if it were ever checked — it must not be checked at all.
    headResolvesAllAbsent();

    const result = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(result.scanned).toBe(0);
    expect(result.newlyAbsent).toBe(0);
    expect(headAttachmentObject).not.toHaveBeenCalled();
    expect(remainingIds()).toEqual(["fresh"]);
  });

  it("sweeps that same row once the clock passes its upload window", async () => {
    // Counterfactual for the test above: identical row, identical (absent) S3
    // state — only the clock moves. Proves the cutoff is what protects a fresh
    // row, rather than the row being spared for some unrelated reason.
    seedRows(row("fresh", JUST_CREATED));
    headResolvesAllAbsent();
    advanceOneDay();

    const first = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });
    advanceOneDay();
    const second = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(first.newlyAbsent).toBe(1);
    expect(second.orphansDeleted).toBe(1);
    expect(remainingIds()).toEqual([]);
  });

  it("marks nothing when the S3 check fails ambiguously", async () => {
    // Same row and same run as the marking case above; only the S3 outcome
    // differs — a transient failure instead of an authoritative 404.
    seedRows(row("orphan", OLD));
    headResolvesBy({ "attachments/org/doc/orphan": "error" });

    const result = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(result.scanned).toBe(1);
    expect(result.newlyAbsent).toBe(0);
    expect(result.ambiguous).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(storedRows[0].reconcileAbsent).toBe(false);
  });

  it("keeps a marked row whose re-check fails ambiguously, and retries it later", async () => {
    seedRows(row("orphan", OLD));
    headResolvesAllAbsent();

    await attachmentRowReconcileService.runRowReconcileSweep({ apply: true });
    headResolvesBy({ "attachments/org/doc/orphan": "error" });
    advanceOneDay();
    const second = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(second.ambiguous).toBe(1);
    expect(second.orphansDeleted).toBe(0);
    expect(remainingIds()).toEqual(["orphan"]);

    // Still marked and still stale, so the next run re-checks it rather than
    // having to rediscover it.
    headResolvesAllAbsent();
    advanceOneDay();
    const third = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(third.orphansDeleted).toBe(1);
    expect(remainingIds()).toEqual([]);
  });
});

describe("attachmentRowReconcileService coverage", () => {
  it("marks every orphan across a page boundary, then deletes them all", async () => {
    // 250 rows is more than one 200-row page. A sweep that paged by Prisma
    // cursor over rows it deletes loses the cursor with the page's last row and
    // stops at 200 — the double models that faithfully, so this fails.
    const ids = Array.from({ length: 250 }, (_, index) =>
      String(index).padStart(3, "0")
    );
    seedRows(...ids.map((id) => row(id, OLD)));
    headResolvesAllAbsent();

    const first = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });
    advanceOneDay();
    const second = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    // The page boundary itself: all 250 were examined in one run, well inside
    // the 2000-row budget. A cursor lost with page 1's last row stops at 200.
    expect(first.scanned).toBe(250);
    expect(first.newlyAbsent).toBe(250);
    expect(second.orphansConfirmed).toBe(250);
    expect(second.orphansDeleted).toBe(250);
    expect(remainingIds()).toEqual([]);
  });

  it("reaches rows behind the scanned prefix on later runs", async () => {
    // Two healthy rows sort ahead of the orphan and fill the whole per-run scan
    // budget. A sweep that restarts from the same end every run never reaches
    // the orphan at all.
    seedRows(
      row("a-healthy", OLD),
      row("b-healthy", OLD),
      row("c-orphan", OLD)
    );
    headResolvesBy({
      "attachments/org/doc/a-healthy": "present",
      "attachments/org/doc/b-healthy": "present",
      "attachments/org/doc/c-orphan": "absent",
    });

    const first = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
      maxRowsScanned: 2,
    });
    advanceOneDay();
    const second = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
      maxRowsScanned: 2,
    });
    advanceOneDay();
    const third = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
      maxRowsScanned: 2,
    });

    expect(remainingIds()).toEqual(["a-healthy", "b-healthy"]);
    expect(first.truncated).toBe(true);
    expect(first.newlyAbsent).toBe(0);
    expect(second.newlyAbsent).toBe(1);
    expect(third.orphansDeleted).toBe(1);
  });

  it("reports a full survey when no cap was reached", async () => {
    seedRows(row("healthy", OLD));
    headResolvesBy({ "attachments/org/doc/healthy": "present" });

    const result = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.summary).toContain("full survey");
  });

  it("says so when the deletion cap leaves confirmed candidates behind", async () => {
    seedRows(row("a", OLD), row("b", OLD), row("c", OLD));
    headResolvesAllAbsent();

    await attachmentRowReconcileService.runRowReconcileSweep({ apply: true });
    advanceOneDay();
    const second = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
      maxDeletions: 2,
    });

    expect(second.orphansConfirmed).toBe(2);
    expect(second.orphansDeleted).toBe(2);
    expect(second.truncated).toBe(true);
    expect(second.summary).toContain("PARTIAL survey");
    expect(remainingIds()).toEqual(["c"]);
  });

  it("clamps a non-positive deletion cap to one row", async () => {
    seedRows(row("a", OLD), row("b", OLD));
    headResolvesAllAbsent();

    await attachmentRowReconcileService.runRowReconcileSweep({ apply: true });
    advanceOneDay();
    const second = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
      maxDeletions: 0,
    });

    expect(second.orphansDeleted).toBe(1);
    expect(remainingIds()).toEqual(["b"]);
  });
});

describe("attachmentRowReconcileService run modes", () => {
  it("reports the confirmed blast radius without deleting when dry-run (the default)", async () => {
    seedRows(row("orphan", OLD));
    headResolvesAllAbsent();

    await attachmentRowReconcileService.runRowReconcileSweep();
    advanceOneDay();
    const second = await attachmentRowReconcileService.runRowReconcileSweep();

    expect(second.dryRun).toBe(true);
    expect(second.orphansConfirmed).toBe(1);
    expect(second.orphansDeleted).toBe(0);
    expect(second.summary).toContain("dry run");
    expect(deleteMany).not.toHaveBeenCalled();
    expect(remainingIds()).toEqual(["orphan"]);
  });

  it("short-circuits to a successful no-op when no bucket is configured", async () => {
    seedRows(row("orphan", OLD));
    vi.mocked(awsKeys).mockReturnValue({
      FILE_ATTACHMENTS_BUCKET: undefined,
    } as unknown as ReturnType<typeof awsKeys>);

    const result = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.orphansDeleted).toBe(0);
    expect(headAttachmentsBucket).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(remainingIds()).toEqual(["orphan"]);
  });

  it("returns exitCode 1 when the sweep itself fails", async () => {
    seedRows(row("orphan", OLD));
    headResolvesAllAbsent();
    findMany.mockRejectedValueOnce(new Error("connection reset"));

    const result = await attachmentRowReconcileService.runRowReconcileSweep({
      apply: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.orphansDeleted).toBe(0);
    expect(remainingIds()).toEqual(["orphan"]);
  });
});
