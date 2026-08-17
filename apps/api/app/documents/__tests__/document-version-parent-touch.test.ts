import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FEA-1626 (wongk review): `Artifact.updatedAt` is what the recency window
// filters on, and the primary save-version path writes DocumentDetail and
// DocumentVersion — both children of the artifact. Without an explicit touch on
// the parent, a two-year-old document edited this morning keeps a two-year-old
// `updatedAt` and ages out of the window while someone is actively working it.
// These tests drive the real service against a mocked transaction client.

const mockWithDbTx = vi.hoisted(() => vi.fn());
const mockArtifactUpdate = vi.hoisted(() => vi.fn());
const mockDetailFindFirst = vi.hoisted(() => vi.fn());
const mockDetailUpdate = vi.hoisted(() => vi.fn());
const mockVersionCreate = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withDb: Object.assign(vi.fn(), { tx: mockWithDbTx }),
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { documentVersionService } from "../document-version-service";

const DOCUMENT_ID = "doc-1";
const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
/** The instant the save happens, pinned so the touch can be asserted exactly. */
const SAVED_AT = new Date("2026-03-04T05:06:07.000Z");

const tx = {
  documentDetail: { findFirst: mockDetailFindFirst, update: mockDetailUpdate },
  documentVersion: { create: mockVersionCreate },
  artifact: { update: mockArtifactUpdate },
};

afterEach(() => {
  // Only one case pins the clock; restore so a later case cannot inherit it.
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockWithDbTx.mockImplementation((fn: (client: typeof tx) => unknown) =>
    fn(tx)
  );
  mockDetailFindFirst.mockResolvedValue({ artifactId: DOCUMENT_ID });
  mockDetailUpdate.mockResolvedValue({ latestVersion: 4 });
  mockVersionCreate.mockResolvedValue({
    id: "version-4",
    version: 4,
    content: "body",
  });
  mockArtifactUpdate.mockResolvedValue({ id: DOCUMENT_ID });
});

describe("documentVersionService.createVersion parent touch (FEA-1626)", () => {
  it("moves the parent artifact's updatedAt on a content save", async () => {
    // Pinned rather than bounded against the wall clock: the property under
    // test is that the service writes *the save's own* timestamp, and an exact
    // equality states that where a `>= before` bound would also pass on a
    // timestamp the service never set (AGENTS.md → Testing).
    vi.useFakeTimers();
    vi.setSystemTime(SAVED_AT);

    const version = await documentVersionService.createVersion(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      USER_ID,
      "body"
    );

    expect(version).toMatchObject({ version: 4 });
    expect(mockArtifactUpdate).toHaveBeenCalledTimes(1);
    const args = mockArtifactUpdate.mock.calls[0]?.[0];
    expect(args?.where).toEqual({ id: DOCUMENT_ID });
    // Explicitly set, not left to Prisma's `@updatedAt` — which needs a real
    // field change to fire and would leave an empty-data update a no-op.
    expect(args?.data?.updatedAt).toBeInstanceOf(Date);
    expect(args.data.updatedAt.getTime()).toBe(SAVED_AT.getTime());
  });

  it("touches the parent inside the SAME transaction as the version insert", async () => {
    await documentVersionService.createVersion(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      USER_ID,
      "body"
    );

    // One transaction, both writes through its client — the timestamp and the
    // version it describes can never be committed apart.
    expect(mockWithDbTx).toHaveBeenCalledTimes(1);
    expect(mockVersionCreate).toHaveBeenCalledTimes(1);
  });

  it("does not touch the parent when the document is missing or cross-org", async () => {
    mockDetailFindFirst.mockResolvedValue(null);

    const version = await documentVersionService.createVersion(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      USER_ID,
      "body"
    );

    expect(version).toBeNull();
    expect(mockArtifactUpdate).not.toHaveBeenCalled();
  });
});
