import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  encryptIntegrationToken: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({ withDb: vi.fn() }));
vi.mock("@repo/database", () => ({ withDb: dbMocks.withDb }));
vi.mock("@/lib/integration-encryption", () => ({
  encryptIntegrationToken: mocks.encryptIntegrationToken,
}));

const { backfillIntegration, backfillSlackIntegrations } = await import(
  "../backfill-integration-tokens"
);

/** Matches BATCH_SIZE in the script under test. */
const BATCH_SIZE = 50;
const ENCRYPT_FAILURE_RE = /Failed to encrypt 1 of 2 rows/;

type Row = { id: string; accessToken: string };

function rows(count: number, offset = 0): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    // Zero-padded so lexical id order matches the numeric order the cursor walks.
    id: `row-${String(index + offset).padStart(4, "0")}`,
    accessToken: `plaintext-${index + offset}`,
  }));
}

/**
 * A config whose `findBatch` honours the cursor and whose `update` reports how
 * many rows it wrote — the two halves the production Prisma configs supply.
 * `written` defaults to 1; return 0 to stand in for a row whose compare-and-set
 * lost to a live connect or refresh.
 */
function fakeConfig(all: Row[], written: (row: Row) => number = () => 1) {
  const updated: string[] = [];
  const config = {
    label: "FakeIntegration",
    count: () => Promise.resolve(all.length),
    findBatch: (afterId: string | null) =>
      Promise.resolve(
        all
          .filter((row) => afterId === null || row.id > afterId)
          .slice(0, BATCH_SIZE)
      ),
    update: (row: Row) => {
      const count = written(row);
      if (count > 0) {
        updated.push(row.id);
      }
      return Promise.resolve(count);
    },
  };
  return { config, updated };
}

beforeEach(() => {
  mocks.encryptIntegrationToken.mockReset();
  mocks.encryptIntegrationToken.mockResolvedValue("ciphertext");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("backfillIntegration cursor walk", () => {
  it("walks every page of a MULTI-BATCH dry run instead of stopping after the first", async () => {
    // A dry run writes nothing, so no row ever leaves the batch filter. Before
    // the cursor this either re-read page one forever or, with a seen-set,
    // stopped after 50 rows and still reported completion — a dry run that
    // silently exercised 4% of the population.
    const all = rows(BATCH_SIZE * 2 + 7);
    const { config } = fakeConfig(all);

    await backfillIntegration(config, true);

    expect(mocks.encryptIntegrationToken).toHaveBeenCalledTimes(all.length);
  });

  it("walks every page of a real run", async () => {
    const all = rows(BATCH_SIZE + 3);
    const { config, updated } = fakeConfig(all);

    await backfillIntegration(config, false);

    expect(updated).toEqual(all.map((row) => row.id));
  });

  it("terminates and leaves the newer credential alone when a row loses the compare-and-set", async () => {
    // `update` resolving 0 is the fence firing: a live connect or refresh stored
    // its own ciphertext between the read and the write, so this run must not
    // put the superseded token back — and must not spin on the row, which stays
    // inside the batch filter.
    const all = rows(3);
    const raced = all[1];
    const { config, updated } = fakeConfig(all, (row) =>
      row.id === raced.id ? 0 : 1
    );

    await backfillIntegration(config, false);

    expect(updated).toEqual([all[0].id, all[2].id]);
    expect(updated).not.toContain(raced.id);
  });

  it("terminates and reports a failure when a row's encrypt throws", async () => {
    const all = rows(2);
    mocks.encryptIntegrationToken
      .mockRejectedValueOnce(new Error("kms unavailable"))
      .mockResolvedValueOnce("ciphertext");
    const { config, updated } = fakeConfig(all);

    // A failed row still counts against the run, so the script exits non-zero
    // rather than reporting a clean backfill.
    await expect(backfillIntegration(config, false)).rejects.toThrow(
      ENCRYPT_FAILURE_RE
    );
    expect(updated).toEqual([all[1].id]);
  });

  it("does nothing and reads no page when the population is empty", async () => {
    const { config } = fakeConfig([]);

    await backfillIntegration(config, false);

    expect(mocks.encryptIntegrationToken).not.toHaveBeenCalled();
  });
});

/**
 * The production configs' own SQL shape. `backfillIntegration` above is driven
 * by a fake config, so nothing there can see whether the real `update` actually
 * carries the compare-and-set — and a silent regression to an id-only `update`
 * would keep every test above green while restoring the stale-token clobber
 * this fence exists to stop.
 */
describe("production config SQL shape", () => {
  function captureDb(row: { id: string; accessToken: string }) {
    const model = {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValueOnce([row]).mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    };
    dbMocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ slackIntegration: model })
    );
    return model;
  }

  it("writes through updateMany fenced on the plaintext the batch read", async () => {
    const row = { id: "row-1", accessToken: "plaintext-in-hand" };
    const model = captureDb(row);

    await backfillSlackIntegrations(false);

    expect(model.update).not.toHaveBeenCalled();
    expect(model.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "row-1",
          accessToken: "plaintext-in-hand",
          accessTokenEncrypted: null,
        },
      })
    );
  });

  it("slack sets only the ciphertext and keeps its NOT NULL plaintext", async () => {
    const model = captureDb({ id: "row-1", accessToken: "plaintext-in-hand" });

    await backfillSlackIntegrations(false);

    expect(model.updateMany.mock.calls[0]?.[0].data).toEqual({
      accessTokenEncrypted: "ciphertext",
    });
  });

  it("pages with a cursor strictly after the last row seen", async () => {
    const row = { id: "row-1", accessToken: "plaintext-in-hand" };
    const model = captureDb(row);

    await backfillSlackIntegrations(false);

    expect(model.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.not.objectContaining({ id: expect.anything() }),
        orderBy: { id: "asc" },
      })
    );
    expect(model.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: { gt: "row-1" } }),
      })
    );
  });
});
