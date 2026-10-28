import { ArtifactType } from "@repo/database";
import { log } from "@repo/observability/log";
import { DOC_SYNC_LIST_DEFAULT_LIMIT } from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "@/__tests__/utils/db-helpers";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock("../internal-client", () => ({
  docSyncInternalClient: () => ({
    listDocuments: mocks.listDocuments,
    deleteDocument: mocks.deleteDocument,
  }),
}));

const { docSyncSweepService, DOC_SYNC_SWEEP_UNPARSEABLE_NAME_EVENT } =
  await import("../sweep-service");

const ORG_A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ORG_B = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const DEADLINE_MS = 60_000;

type Row = { organizationId: string; slug: string; type: ArtifactType };
type Where = { OR: Partial<Row>[] };

/** Evaluates the sweep's `OR` the way Prisma does: a field the filter leaves out matches any value. */
function artifactsTable(rows: Row[]) {
  const findMany = vi.fn(({ where }: { where: Where }) =>
    Promise.resolve(
      rows
        .filter((row) =>
          where.OR.some((match) =>
            Object.entries(match).every(
              ([field, value]) => row[field as keyof Row] === value
            )
          )
        )
        .map(({ organizationId, slug }) => ({ organizationId, slug }))
    )
  );
  mockWithDbCall({ artifact: { findMany } });
  return findMany;
}

function page(names: string[], nextAfter: string | null = null) {
  return { ok: true, value: { names, nextAfter } };
}

const deleted = { ok: true, value: { deleted: true, wasLoaded: false } };

beforeEach(() => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  mocks.deleteDocument.mockResolvedValue(deleted);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  mocks.listDocuments.mockReset();
  mocks.deleteDocument.mockReset();
});

describe("docSyncSweepService.run", () => {
  it("deletes only the documents missing from the app database, across two orgs", async () => {
    const a1 = generateDocumentRoomId(ORG_A, "PRD-1");
    const a2 = generateDocumentRoomId(ORG_A, "PRD-2");
    const b1 = generateDocumentRoomId(ORG_B, "PRD-1");
    const b2 = generateDocumentRoomId(ORG_B, "PRD-2");
    artifactsTable([
      { organizationId: ORG_A, slug: "PRD-1", type: ArtifactType.DOCUMENT },
      { organizationId: ORG_B, slug: "PRD-2", type: ArtifactType.DOCUMENT },
    ]);
    mocks.listDocuments.mockResolvedValue(page([a1, a2, b1, b2]));

    const summary = await docSyncSweepService.run({ deadlineMs: DEADLINE_MS });

    expect(
      mocks.deleteDocument.mock.calls.map(([name]) => name).sort()
    ).toEqual([a2, b1].sort());
    expect(summary).toEqual({
      scanned: 4,
      deleted: 2,
      kept: 2,
      unparseable: 0,
      failed: 0,
      truncated: false,
      notConfigured: false,
    });
  });

  it("does not count a non-document artifact with the same slug as existing", async () => {
    const name = generateDocumentRoomId(ORG_A, "BR-1");
    artifactsTable([
      { organizationId: ORG_A, slug: "BR-1", type: ArtifactType.BRANCH },
    ]);
    mocks.listDocuments.mockResolvedValue(page([name]));

    await docSyncSweepService.run({ deadlineMs: DEADLINE_MS });

    expect(mocks.deleteDocument).toHaveBeenCalledWith(name);
  });

  it.each([
    ["not a room id", "health-check"],
    ["a legacy namespace", `${ORG_A}:document:PRD-1`],
    ["a non-uuid organization", "org_123:artifact:PRD-1"],
  ])("keeps and counts a name that is %s", async (_, name) => {
    const findMany = artifactsTable([]);
    mocks.listDocuments.mockResolvedValue(page([name]));

    const summary = await docSyncSweepService.run({ deadlineMs: DEADLINE_MS });

    expect(mocks.deleteDocument).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 1, unparseable: 1, kept: 0 });
    expect(vi.mocked(log.warn).mock.calls[0]?.[1]).toEqual({
      event: DOC_SYNC_SWEEP_UNPARSEABLE_NAME_EVENT,
      name,
    });
  });

  it("follows nextAfter across pages until it is null", async () => {
    const first = generateDocumentRoomId(ORG_A, "PRD-1");
    const second = generateDocumentRoomId(ORG_A, "PRD-2");
    artifactsTable([]);
    mocks.listDocuments
      .mockResolvedValueOnce(page([first], first))
      .mockResolvedValueOnce(page([second]));

    const summary = await docSyncSweepService.run({ deadlineMs: DEADLINE_MS });

    expect(mocks.listDocuments.mock.calls).toEqual([
      [{ after: undefined, limit: DOC_SYNC_LIST_DEFAULT_LIMIT }],
      [{ after: first, limit: DOC_SYNC_LIST_DEFAULT_LIMIT }],
    ]);
    expect(mocks.deleteDocument.mock.calls).toEqual([[first], [second]]);
    expect(summary).toMatchObject({ scanned: 2, deleted: 2, truncated: false });
  });

  it("stops at the deadline and reports truncated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T06:29:00.000Z"));
    const first = generateDocumentRoomId(ORG_A, "PRD-1");
    artifactsTable([]);
    mocks.listDocuments.mockImplementationOnce(() => {
      vi.setSystemTime(Date.now() + DEADLINE_MS);
      return Promise.resolve(page([first], first));
    });

    const summary = await docSyncSweepService.run({ deadlineMs: DEADLINE_MS });

    expect(mocks.listDocuments).toHaveBeenCalledTimes(1);
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 1, deleted: 0, truncated: true });
  });

  it("lists no further page once the deadline has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T06:29:00.000Z"));
    const first = generateDocumentRoomId(ORG_A, "PRD-1");
    artifactsTable([
      { organizationId: ORG_A, slug: "PRD-1", type: ArtifactType.DOCUMENT },
    ]);
    mocks.listDocuments
      .mockImplementationOnce(() => {
        vi.setSystemTime(Date.now() + DEADLINE_MS);
        return Promise.resolve(page([first], first));
      })
      .mockResolvedValue(page([]));

    const summary = await docSyncSweepService.run({ deadlineMs: DEADLINE_MS });

    expect(mocks.listDocuments).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ scanned: 1, kept: 1, truncated: true });
  });

  it("deletes nothing when the list fails", async () => {
    const findMany = artifactsTable([]);
    mocks.listDocuments.mockResolvedValue({
      ok: false,
      failure: InternalCallFailure.Unreachable,
    });

    const summary = await docSyncSweepService.run({ deadlineMs: DEADLINE_MS });

    expect(findMany).not.toHaveBeenCalled();
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 0, failed: 1 });
  });

  it("counts a failed delete", async () => {
    const name = generateDocumentRoomId(ORG_A, "PRD-1");
    artifactsTable([]);
    mocks.listDocuments.mockResolvedValue(page([name]));
    mocks.deleteDocument.mockResolvedValue({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 503,
    });

    const summary = await docSyncSweepService.run({ deadlineMs: DEADLINE_MS });

    expect(summary).toMatchObject({ deleted: 0, failed: 1 });
  });

  it("reports an unconfigured doc-sync without a failure", async () => {
    artifactsTable([]);
    mocks.listDocuments.mockResolvedValue({
      ok: false,
      failure: InternalCallFailure.NotConfigured,
    });

    const summary = await docSyncSweepService.run({ deadlineMs: DEADLINE_MS });

    expect(summary).toMatchObject({ failed: 0, notConfigured: true });
  });
});
