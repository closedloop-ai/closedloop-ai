import { log } from "@repo/observability/log";
import { ChannelKind } from "@repo/realtime-contract/channels";
import { DocumentVersionSignalType } from "@repo/realtime-contract/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEmitSignal = vi.hoisted(() => vi.fn());
const FAKE_DB = vi.hoisted(() => ({ $executeRaw: vi.fn() }));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) => fn(FAKE_DB),
}));

vi.mock("@repo/realtime-server/emit-signal", () => ({
  emitSignal: (...args: unknown[]) => mockEmitSignal(...args),
}));

const { DOCUMENT_VERSION_SIGNAL_FAILED_EVENT, emitDocumentVersionPublished } =
  await import("../version-published-signal");

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DOCUMENT_ID = "01a140d8-7298-7688-8841-0a3cc7d38719";

beforeEach(() => {
  mockEmitSignal.mockReset().mockResolvedValue(undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitDocumentVersionPublished", () => {
  it("emits version.published with the version only, on the document's channel, outside a transaction", async () => {
    await emitDocumentVersionPublished({
      organizationId: ORG_ID,
      documentId: DOCUMENT_ID,
      version: 4,
    });

    expect(mockEmitSignal).toHaveBeenCalledWith(
      FAKE_DB,
      `${ChannelKind.DocumentVersions}:${ORG_ID}:${DOCUMENT_ID}`,
      { type: DocumentVersionSignalType.Published, data: { version: 4 } }
    );
  });

  it("logs document_version.signal_failed with ids and version, and resolves", async () => {
    mockEmitSignal.mockRejectedValue(new Error("notify failed"));

    await expect(
      emitDocumentVersionPublished({
        organizationId: ORG_ID,
        documentId: DOCUMENT_ID,
        version: 4,
      })
    ).resolves.toBeUndefined();
    expect(vi.mocked(log.error).mock.calls).toEqual([
      [
        expect.any(String),
        {
          event: DOCUMENT_VERSION_SIGNAL_FAILED_EVENT,
          documentId: DOCUMENT_ID,
          organizationId: ORG_ID,
          version: 4,
        },
      ],
    ]);
  });
});
