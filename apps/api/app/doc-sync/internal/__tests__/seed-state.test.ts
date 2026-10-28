import { log } from "@repo/observability/log";
import { SeedVersionMode } from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocSyncCallResult } from "../internal-client";

const mockSeedVersion = vi.hoisted(() => vi.fn());

vi.mock("../internal-client", () => ({
  docSyncInternalClient: () => ({ seedVersion: mockSeedVersion }),
}));

const { publishVersionToLiveDocument } = await import("../seed-state");

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const PUBLISH = {
  document: { organizationId: ORG_ID, slug: "PRD-42" },
  content: "# Plan",
  version: 7,
};
const SEEDED = {
  ok: true,
  value: { applied: true, stale: false, updateBytes: 12 },
} as const;

function rejected(status: number): DocSyncCallResult<never> {
  return { ok: false, failure: InternalCallFailure.Rejected, status };
}

beforeEach(() => {
  mockSeedVersion.mockReset();
  vi.spyOn(log, "info");
  vi.spyOn(log, "warn");
  vi.spyOn(log, "error");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishVersionToLiveDocument", () => {
  it("seeds the document's room with the content and version", async () => {
    mockSeedVersion.mockResolvedValue(SEEDED);

    await expect(publishVersionToLiveDocument(PUBLISH)).resolves.toEqual(
      SEEDED
    );
    expect(mockSeedVersion).toHaveBeenCalledWith(
      generateDocumentRoomId(ORG_ID, "PRD-42"),
      { markdown: "# Plan", version: 7 }
    );
  });

  it("passes a reset's mode to the service", async () => {
    mockSeedVersion.mockResolvedValue(SEEDED);

    await publishVersionToLiveDocument({
      ...PUBLISH,
      mode: SeedVersionMode.Reset,
    });

    expect(mockSeedVersion).toHaveBeenCalledWith(
      generateDocumentRoomId(ORG_ID, "PRD-42"),
      { markdown: "# Plan", version: 7, mode: SeedVersionMode.Reset }
    );
  });

  it.each([
    {
      name: "unreachable",
      first: { ok: false, failure: InternalCallFailure.Unreachable },
    },
    { name: "a 429", first: rejected(429) },
    { name: "a 503", first: rejected(503) },
  ])(
    "retries once after $name and returns the second result",
    async ({ first }) => {
      mockSeedVersion
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(SEEDED);

      await expect(publishVersionToLiveDocument(PUBLISH)).resolves.toEqual(
        SEEDED
      );
      expect(mockSeedVersion).toHaveBeenCalledTimes(2);
    }
  );

  it("makes at most two attempts and returns the last failure", async () => {
    mockSeedVersion
      .mockResolvedValueOnce(rejected(503))
      .mockResolvedValueOnce(rejected(502));

    await expect(publishVersionToLiveDocument(PUBLISH)).resolves.toEqual(
      rejected(502)
    );
    expect(mockSeedVersion).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "a 410", result: rejected(410) },
    {
      name: "not configured",
      result: { ok: false, failure: InternalCallFailure.NotConfigured },
    },
  ])("does not retry $name", async ({ result }) => {
    mockSeedVersion.mockResolvedValue(result);

    await expect(publishVersionToLiveDocument(PUBLISH)).resolves.toEqual(
      result
    );
    expect(mockSeedVersion).toHaveBeenCalledTimes(1);
  });

  it("logs nothing itself: the client logs each failed attempt", async () => {
    mockSeedVersion.mockResolvedValue(rejected(503));

    await publishVersionToLiveDocument(PUBLISH);

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
