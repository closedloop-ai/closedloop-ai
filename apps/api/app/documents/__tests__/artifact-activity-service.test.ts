/**
 * Unit tests for artifactActivityService (FEA-3859 / FEA-3535 Slice 1).
 *
 * All database calls are mocked via vi.mock("@repo/database"); each test wires
 * the specific delegate method (`artifactActivityEvent.create` / `.createMany`
 * / `.findMany`) it exercises. Tests verify:
 *   - recordActivityEvent persists a validated, org-scoped row and maps it back
 *     to the shared DTO, including the JSON-null vs SQL-null snapshot sentinels.
 *   - recordActivityEvent rejects out-of-vocabulary actorType / action and
 *     missing ids via Zod before touching the DB.
 *   - recordActivityEvents (batch) inserts the whole batch through ONE
 *     tenant-scoped transaction (one findMany + one createMany — bounded
 *     fan-out) and drops events for artifacts outside the org.
 *   - listActivityEvents scopes by (organizationId, artifactId), orders
 *     newest-first, and paginates by keyset cursor with a lookahead nextCursor.
 */
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const withDbFn = vi.fn();
  return {
    Prisma: { JsonNull: "JsonNull", DbNull: "DbNull" },
    withDb: Object.assign(withDbFn, { tx: vi.fn() }),
  };
});

import { Prisma, withDb } from "@repo/database";
import { artifactActivityService } from "../artifact-activity-service";

const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = withDb.tx as unknown as Mock;

const ORG_ID = "org-1";
const ARTIFACT_ID = "artifact-1";
const USER_ID = "user-1";

type Row = {
  id: string;
  organizationId: string;
  artifactId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "event-1",
    organizationId: ORG_ID,
    artifactId: ARTIFACT_ID,
    actorType: ArtifactActivityActorType.User,
    actorId: USER_ID,
    action: ArtifactActivityAction.StatusChange,
    before: "DRAFT",
    after: "IN_REVIEW",
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * Wire withDb.tx to a tx client whose artifact.findFirst resolves the
 * (org-owned) artifact and whose artifactActivityEvent.create returns `row`.
 * Pass `ownedArtifact: null` to simulate an artifact that does not belong to
 * the caller's organization (tenant-guard rejection).
 */
function mockCreate(
  row: Row,
  { ownedArtifact = true }: { ownedArtifact?: boolean } = {}
) {
  const create = vi.fn().mockResolvedValue(row);
  const findFirst = vi
    .fn()
    .mockResolvedValue(ownedArtifact ? { id: row.artifactId } : null);
  mockWithDbTx.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
    fn({ artifact: { findFirst }, artifactActivityEvent: { create } })
  );
  return { create, findFirst };
}

/** Wire withDb to a client whose artifactActivityEvent.findMany returns `rows`. */
function mockFindMany(rows: Row[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({ artifactActivityEvent: { findMany } })
  );
  return findMany;
}

/**
 * Wire withDb.tx to a tx client whose `artifact.findMany` resolves the set of
 * org-owned artifact ids (from `ownedIds`) and whose
 * `artifactActivityEvent.createMany` records the batch insert. Used by the
 * `recordActivityEvents` batch tests.
 */
function mockBatchCreate(ownedIds: string[]) {
  const artifactFindMany = vi
    .fn()
    .mockResolvedValue(ownedIds.map((id) => ({ id })));
  const createMany = vi.fn(({ data }: { data: unknown[] }) =>
    Promise.resolve({ count: data.length })
  );
  mockWithDbTx.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
    fn({
      artifact: { findMany: artifactFindMany },
      artifactActivityEvent: { createMany },
    })
  );
  return { artifactFindMany, createMany };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets call history but NOT the queued mockImplementationOnce
  // impls; reset the withDb mocks so a prior test's unconsumed queue can't leak.
  mockWithDb.mockReset();
  mockWithDbTx.mockReset();
});

describe("artifactActivityService.recordActivityEvent", () => {
  it("persists an org-scoped row and maps it to the shared DTO", async () => {
    const { create, findFirst } = mockCreate(makeRow());

    const event = await artifactActivityService.recordActivityEvent({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
      actorType: ArtifactActivityActorType.User,
      actorId: USER_ID,
      action: ArtifactActivityAction.StatusChange,
      before: "DRAFT",
      after: "IN_REVIEW",
    });

    expect(create).toHaveBeenCalledTimes(1);
    // Tenant guard: the artifact is looked up scoped to (id, organizationId).
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: ARTIFACT_ID,
      organizationId: ORG_ID,
    });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
      actorType: "user",
      actorId: USER_ID,
      action: "status_change",
      before: "DRAFT",
      after: "IN_REVIEW",
    });

    expect(event).toEqual({
      id: "event-1",
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
      actorType: "user",
      actorId: USER_ID,
      action: "status_change",
      before: "DRAFT",
      after: "IN_REVIEW",
      createdAt: new Date("2026-07-22T00:00:00.000Z"),
    });
  });

  it("writes SQL NULL (DbNull) for an omitted before on a creation event", async () => {
    const { create } = mockCreate(
      makeRow({
        action: ArtifactActivityAction.Creation,
        actorId: null,
        actorType: ArtifactActivityActorType.System,
        before: null,
        after: { name: "New PRD" },
      })
    );

    await artifactActivityService.recordActivityEvent({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
      actorType: ArtifactActivityActorType.System,
      action: ArtifactActivityAction.Creation,
      after: { name: "New PRD" },
    });

    const data = create.mock.calls[0][0].data;
    // Omitted `before` → SQL NULL sentinel; `actorId` defaults to null.
    expect(data.before).toBe(Prisma.DbNull);
    expect(data.actorId).toBeNull();
    expect(data.after).toEqual({ name: "New PRD" });
  });

  it("writes JSON null (JsonNull) for an explicit null after (cleared field)", async () => {
    const { create } = mockCreate(
      makeRow({
        action: ArtifactActivityAction.Assignment,
        before: "user-9",
        after: null,
      })
    );

    await artifactActivityService.recordActivityEvent({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
      actorType: ArtifactActivityActorType.User,
      actorId: USER_ID,
      action: ArtifactActivityAction.Assignment,
      before: "user-9",
      after: null,
    });

    const data = create.mock.calls[0][0].data;
    expect(data.after).toBe(Prisma.JsonNull);
  });

  it("rejects an out-of-vocabulary action before touching the DB", async () => {
    await expect(
      artifactActivityService.recordActivityEvent({
        organizationId: ORG_ID,
        artifactId: ARTIFACT_ID,
        actorType: ArtifactActivityActorType.User,
        actorId: USER_ID,
        // @ts-expect-error — invalid action value must be rejected by Zod.
        action: "deleted",
      })
    ).rejects.toThrow();
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });

  it("rejects an out-of-vocabulary actorType before touching the DB", async () => {
    await expect(
      artifactActivityService.recordActivityEvent({
        organizationId: ORG_ID,
        artifactId: ARTIFACT_ID,
        // @ts-expect-error — invalid actorType value must be rejected by Zod.
        actorType: "robot",
        action: ArtifactActivityAction.Creation,
      })
    ).rejects.toThrow();
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });

  it("rejects a missing artifactId before touching the DB", async () => {
    await expect(
      artifactActivityService.recordActivityEvent({
        organizationId: ORG_ID,
        artifactId: "",
        actorType: ArtifactActivityActorType.System,
        action: ArtifactActivityAction.Creation,
      })
    ).rejects.toThrow();
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });

  it("rejects an artifact that does not belong to the caller's organization", async () => {
    // The artifact lookup resolves null (no row for this org) → the tenant
    // guard rejects before the activity row is inserted.
    const { create, findFirst } = mockCreate(makeRow(), {
      ownedArtifact: false,
    });

    await expect(
      artifactActivityService.recordActivityEvent({
        organizationId: ORG_ID,
        artifactId: ARTIFACT_ID,
        actorType: ArtifactActivityActorType.User,
        actorId: USER_ID,
        action: ArtifactActivityAction.StatusChange,
        before: "DRAFT",
        after: "IN_REVIEW",
      })
    ).rejects.toThrow();

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("artifactActivityService.recordActivityEvents (batch)", () => {
  it("inserts the whole batch with ONE createMany inside ONE transaction (bounded fan-out)", async () => {
    const { artifactFindMany, createMany } = mockBatchCreate(["a1", "a2"]);

    const inserted = await artifactActivityService.recordActivityEvents({
      organizationId: ORG_ID,
      events: [
        {
          artifactId: "a1",
          actorType: ArtifactActivityActorType.User,
          actorId: USER_ID,
          action: ArtifactActivityAction.StatusChange,
          before: "DRAFT",
          after: "APPROVED",
        },
        {
          artifactId: "a2",
          actorType: ArtifactActivityActorType.User,
          actorId: USER_ID,
          action: ArtifactActivityAction.StatusChange,
          before: "IN_REVIEW",
          after: "APPROVED",
        },
      ],
    });

    // One transaction total (not one per artifact), one tenant-scoped lookup,
    // one bulk insert. This is the P1 bounded-fan-out fix.
    expect(mockWithDbTx).toHaveBeenCalledTimes(1);
    expect(artifactFindMany).toHaveBeenCalledTimes(1);
    expect(artifactFindMany.mock.calls[0][0].where).toEqual({
      id: { in: ["a1", "a2"] },
      organizationId: ORG_ID,
    });
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
      organizationId: ORG_ID,
      artifactId: "a1",
      actorType: "user",
      action: "status_change",
      before: "DRAFT",
      after: "APPROVED",
    });
    expect(inserted).toBe(2);
  });

  it("TENANT GUARD: drops events whose artifact does not belong to the org", async () => {
    // Only a1 belongs to the org; the a2 event must be excluded from the insert.
    const { createMany } = mockBatchCreate(["a1"]);

    const inserted = await artifactActivityService.recordActivityEvents({
      organizationId: ORG_ID,
      events: [
        {
          artifactId: "a1",
          actorType: ArtifactActivityActorType.User,
          actorId: USER_ID,
          action: ArtifactActivityAction.StatusChange,
          before: "DRAFT",
          after: "APPROVED",
        },
        {
          artifactId: "a2",
          actorType: ArtifactActivityActorType.User,
          actorId: USER_ID,
          action: ArtifactActivityAction.StatusChange,
          before: "DRAFT",
          after: "APPROVED",
        },
      ],
    });

    const data = createMany.mock.calls[0][0].data as Array<{
      artifactId: string;
    }>;
    expect(data.map((d) => d.artifactId)).toEqual(["a1"]);
    expect(inserted).toBe(1);
  });

  it("does not open a transaction for an empty batch", async () => {
    const inserted = await artifactActivityService.recordActivityEvents({
      organizationId: ORG_ID,
      events: [],
    });
    expect(inserted).toBe(0);
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });

  it("inserts nothing when none of the artifacts belong to the org", async () => {
    const { createMany } = mockBatchCreate([]);

    const inserted = await artifactActivityService.recordActivityEvents({
      organizationId: ORG_ID,
      events: [
        {
          artifactId: "a1",
          actorType: ArtifactActivityActorType.User,
          actorId: USER_ID,
          action: ArtifactActivityAction.StatusChange,
          before: "DRAFT",
          after: "APPROVED",
        },
      ],
    });

    expect(createMany).not.toHaveBeenCalled();
    expect(inserted).toBe(0);
  });

  it("rejects an out-of-vocabulary action before touching the DB", async () => {
    await expect(
      artifactActivityService.recordActivityEvents({
        organizationId: ORG_ID,
        events: [
          {
            artifactId: "a1",
            actorType: ArtifactActivityActorType.User,
            actorId: USER_ID,
            // @ts-expect-error — invalid action value must be rejected by Zod.
            action: "deleted",
          },
        ],
      })
    ).rejects.toThrow();
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });
});

describe("artifactActivityService.listActivityEvents", () => {
  it("scopes by org + artifact and orders newest-first", async () => {
    const findMany = mockFindMany([makeRow({ id: "e1" })]);

    const result = await artifactActivityService.listActivityEvents({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
    });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
    });
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("e1");
    expect(result.nextCursor).toBeNull();
  });

  it("clamps limit to the max and requests a lookahead row", async () => {
    const findMany = mockFindMany([]);

    await artifactActivityService.listActivityEvents({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
      limit: 500,
    });

    // 500 clamped to max 100, plus one lookahead row.
    expect(findMany.mock.calls[0][0].take).toBe(101);
  });

  it("returns nextCursor and trims the lookahead row when more pages exist", async () => {
    // Request limit 2; the service fetches 3 (take+1). The 3rd row is the
    // lookahead and must NOT appear in the returned page.
    const rows = [
      makeRow({ id: "e1" }),
      makeRow({ id: "e2" }),
      makeRow({ id: "e3" }),
    ];
    const findMany = mockFindMany(rows);

    const result = await artifactActivityService.listActivityEvents({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
      limit: 2,
    });

    expect(findMany.mock.calls[0][0].take).toBe(3);
    expect(result.items.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(result.nextCursor).toBe("e2");
  });

  it("passes the cursor through as a keyset skip when provided", async () => {
    const findMany = mockFindMany([makeRow({ id: "e5" })]);

    await artifactActivityService.listActivityEvents({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
      cursor: "e4",
      limit: 10,
    });

    const args = findMany.mock.calls[0][0];
    expect(args.cursor).toEqual({ id: "e4" });
    expect(args.skip).toBe(1);
  });

  it("omits cursor/skip on the first page", async () => {
    const findMany = mockFindMany([makeRow({ id: "e1" })]);

    await artifactActivityService.listActivityEvents({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
    });

    const args = findMany.mock.calls[0][0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("rejects a missing organizationId before touching the DB", async () => {
    await expect(
      artifactActivityService.listActivityEvents({
        organizationId: "",
        artifactId: ARTIFACT_ID,
      })
    ).rejects.toThrow();
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("unwraps the Prisma.JsonNull sentinel on read to a plain null", async () => {
    // Prisma may surface a JSON `null` column as the JsonNull sentinel rather
    // than plain null; the DTO must normalize it so the round-trip is lossless.
    mockFindMany([
      makeRow({ id: "e1", before: Prisma.JsonNull, after: Prisma.JsonNull }),
    ]);

    const result = await artifactActivityService.listActivityEvents({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(result.items[0].before).toBeNull();
    expect(result.items[0].after).toBeNull();
  });
});
