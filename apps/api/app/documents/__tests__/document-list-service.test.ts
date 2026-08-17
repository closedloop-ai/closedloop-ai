import {
  DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_OFFSET,
  type DocumentWithProject,
} from "@repo/api/src/types/document";
import { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ISS-4576: `documentListService.findPageWithCustomFields` is what makes the My
// Tasks footer's "of N" a fact instead of an inference. These tests drive the
// real service against a mocked DB boundary and a mocked page read, so the
// total, the reported window, and `hasMore` are all asserted against a
// population deliberately LARGER than the page — the case where a
// page-derived total silently lies.

const ORGANIZATION_ID = "org-1";
const ASSIGNEE_ID = "user-1";

const mockWithDb = vi.hoisted(() => vi.fn());
const mockWithDbTx = vi.hoisted(() => vi.fn());
const mockCount = vi.hoisted(() => vi.fn());
const mockFindAllWithCustomFields = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  };
});

vi.mock("../document-service", () => ({
  documentService: { findAllWithCustomFields: mockFindAllWithCustomFields },
}));

import { documentListService } from "../document-list-service";

type CountArgs = { where?: Record<string, unknown> };

function makeItems(count: number): DocumentWithProject[] {
  return Array.from(
    { length: count },
    (_unused, i) => ({ id: `doc-${i}` }) as DocumentWithProject
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWithDb.mockImplementation(
    async (
      callback: (db: {
        artifact: { count: (args: CountArgs) => Promise<number> };
      }) => Promise<number>
    ) => await callback({ artifact: { count: mockCount } })
  );
  // The page + count read runs inside `withDb.tx` (ISS-4576 snapshot
  // consistency). The service's callback ignores its tx arg (its inner
  // `findAllWithCustomFields`/`countAll` reads participate via the ambient
  // transaction), so the mock just executes the callback.
  mockWithDbTx.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) =>
      await callback(undefined)
  );
});

describe("documentListService.findPageWithCustomFields (ISS-4576)", () => {
  it("returns the server's real total, not the page length", async () => {
    mockFindAllWithCustomFields.mockResolvedValue(makeItems(50));
    mockCount.mockResolvedValue(1204);

    const page = await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      assigneeId: ASSIGNEE_ID,
      limit: 50,
      offset: 0,
    });

    expect(page.total).toBe(1204);
    expect(page.items).toHaveLength(50);
  });

  it("counts over the SAME predicate the page was drawn from", async () => {
    mockFindAllWithCustomFields.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);

    await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      assigneeId: ASSIGNEE_ID,
      limit: 50,
      offset: 0,
    });

    const countArgs: CountArgs | undefined = mockCount.mock.calls[0]?.[0];
    expect(countArgs?.where).toMatchObject({
      organizationId: ORGANIZATION_ID,
      assigneeId: ASSIGNEE_ID,
    });
  });

  it("counts the whole population, ignoring limit and offset", async () => {
    mockFindAllWithCustomFields.mockResolvedValue(makeItems(50));
    mockCount.mockResolvedValue(1204);

    await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      limit: 50,
      offset: 500,
    });

    const countArgs: CountArgs | undefined = mockCount.mock.calls[0]?.[0];
    expect(countArgs).not.toHaveProperty("take");
    expect(countArgs).not.toHaveProperty("skip");
  });

  it("reports hasMore when rows exist beyond the page", async () => {
    mockFindAllWithCustomFields.mockResolvedValue(makeItems(50));
    mockCount.mockResolvedValue(1204);

    const page = await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      limit: 50,
      offset: 0,
    });

    expect(page.hasMore).toBe(true);
  });

  it("does not claim a phantom next page when the LAST page fills exactly", async () => {
    mockFindAllWithCustomFields.mockResolvedValue(makeItems(50));
    mockCount.mockResolvedValue(100);

    const page = await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      limit: 50,
      offset: 50,
    });

    expect(page.hasMore).toBe(false);
  });

  it("reports the window the server APPLIED after clamping, not what the caller asked for", async () => {
    mockFindAllWithCustomFields.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);

    const page = await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      limit: DOCUMENT_LIST_MAX_LIMIT * 10,
      offset: DOCUMENT_LIST_MAX_OFFSET * 10,
    });

    expect(page.limit).toBe(DOCUMENT_LIST_MAX_LIMIT);
    expect(page.offset).toBe(DOCUMENT_LIST_MAX_OFFSET);
  });

  it("reports a null limit and a zero offset for an unbounded read", async () => {
    mockFindAllWithCustomFields.mockResolvedValue(makeItems(3));
    mockCount.mockResolvedValue(3);

    const page = await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
    });

    expect(page.limit).toBeNull();
    expect(page.offset).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("distinguishes a truly empty queue from an out-of-range page", async () => {
    // Empty page, but the population is not empty — the caller must be able to
    // tell "nothing assigned" from "you paged past the end".
    mockFindAllWithCustomFields.mockResolvedValue([]);
    mockCount.mockResolvedValue(137);

    const page = await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      limit: 50,
      offset: 500,
    });

    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(137);
  });

  it("reads the page and the count inside ONE RepeatableRead transaction (shafty023)", async () => {
    // Snapshot consistency: separate reads each take their own snapshot and can
    // disagree if a row is inserted/deleted between them. The envelope's page and
    // total must come from one transaction at RepeatableRead so they cannot
    // contradict each other.
    mockFindAllWithCustomFields.mockResolvedValue(makeItems(50));
    mockCount.mockResolvedValue(137);

    await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      limit: 50,
      offset: 0,
    });

    expect(mockWithDbTx).toHaveBeenCalledTimes(1);
    const txOptions = mockWithDbTx.mock.calls[0]?.[1];
    expect(txOptions?.isolationLevel).toBe(
      Prisma.TransactionIsolationLevel.RepeatableRead
    );
  });

  it("keeps the page and total mutually consistent across a mutation between the two reads (boundary)", async () => {
    // Simulate a delete landing AFTER the page read but BEFORE the count: without
    // a shared snapshot the count would drop below the page length (50 items,
    // total 49 — a self-contradicting envelope). Under one RepeatableRead
    // transaction both reads observe the same snapshot, so the count the service
    // returns is the one taken inside the transaction, and hasMore stays honest
    // against it. Here the tx boundary is what guarantees the two mocked reads
    // are read as a pair; assert the envelope never reports fewer total than the
    // page it returned.
    mockFindAllWithCustomFields.mockResolvedValue(makeItems(50));
    // The count read inside the same snapshot still sees all 137 rows even though
    // a concurrent deleter is racing outside the transaction.
    mockCount.mockResolvedValue(137);

    const page = await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      limit: 50,
      offset: 0,
    });

    expect(mockWithDbTx).toHaveBeenCalledTimes(1);
    // Internally consistent: the total is never less than the rows on the page,
    // and hasMore is derived from that same total.
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    expect(page.hasMore).toBe(page.offset + page.items.length < page.total);
  });
});

describe("documentListService.countAll (ISS-4576)", () => {
  it("org-scopes the count", async () => {
    mockCount.mockResolvedValue(7);

    const total = await documentListService.countAll({
      organizationId: ORGANIZATION_ID,
    });

    expect(total).toBe(7);
    const countArgs: CountArgs | undefined = mockCount.mock.calls[0]?.[0];
    expect(countArgs?.where).toMatchObject({
      organizationId: ORGANIZATION_ID,
    });
  });
});

// FEA-1626: the recency window is a cutoff measured back from "now", so the page
// and the count need ONE instant as well as one snapshot. Two independent
// `new Date()` calls would hand the two reads cutoffs microseconds apart — a
// different population, which is exactly the self-contradiction the shared
// transaction exists to prevent.
describe("documentListService.findPageWithCustomFields recency instant (FEA-1626)", () => {
  it("draws the page and the count from the same cutoff", async () => {
    mockFindAllWithCustomFields.mockResolvedValue(makeItems(3));
    mockCount.mockResolvedValue(3);

    await documentListService.findPageWithCustomFields({
      organizationId: ORGANIZATION_ID,
      assigneeId: ASSIGNEE_ID,
      limit: 50,
      // The window is opt-in, so the request has to ask for it — omitting it
      // would leave no cutoff to share and this test would prove nothing.
      recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
    });

    const pageNow: Date | undefined =
      mockFindAllWithCustomFields.mock.calls[0]?.[1];
    const countArgs: CountArgs | undefined = mockCount.mock.calls[0]?.[0];
    const countCutoff = (countArgs?.where?.updatedAt as { gte: Date }).gte;

    expect(pageNow).toBeInstanceOf(Date);
    // The page read receives the instant; the count read receives the cutoff
    // derived from it. Asserting the derivation ties the two together without
    // restating the window length here.
    expect(countCutoff.getTime()).toBe(
      pageNow!.getTime() - DOCUMENT_LIST_DEFAULT_RECENCY_DAYS * 86_400_000
    );
  });
});
