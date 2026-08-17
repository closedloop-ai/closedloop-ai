import { DocumentType } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRoomMetadata } from "../server/room-metadata";

const { liveblocksSecrets, mockGetRoom, secrets } = vi.hoisted(() => ({
  liveblocksSecrets: [] as string[],
  mockGetRoom: vi.fn(),
  secrets: { liveblocks: "sk_test-secret" as string | undefined },
}));

vi.mock("@liveblocks/node", () => ({
  Liveblocks: class {
    getRoom = mockGetRoom;

    constructor({ secret }: { secret: string }) {
      liveblocksSecrets.push(secret);
    }
  },
}));

vi.mock("../server/keys", () => ({
  keys: () => ({ LIVEBLOCKS_SECRET: secrets.liveblocks }),
}));

describe("resolveRoomMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveblocksSecrets.length = 0;
    secrets.liveblocks = "sk_test-secret";
  });

  it("uses current and legacy metadata in priority order with scoped URLs", async () => {
    mockGetRoom
      .mockResolvedValueOnce({
        metadata: {
          artifactType: DocumentType.Feature,
          documentType: DocumentType.Prd,
        },
      })
      .mockResolvedValueOnce({
        metadata: {
          artifactSubtype: DocumentType.ImplementationPlan,
          artifactType: DocumentType.Feature,
          documentType: "",
        },
      })
      .mockResolvedValueOnce({
        metadata: { artifactSubtype: DocumentType.ImplementationPlan },
      })
      .mockResolvedValueOnce({
        metadata: { documentType: DocumentType.Template },
      })
      .mockResolvedValueOnce({ metadata: {} })
      .mockRejectedValueOnce(new Error("room missing"));

    const result = await resolveRoomMetadata(
      [
        "org:artifact:PRD-1",
        "org:artifact:ISS-2",
        "org:document:PLN-3",
        "org:artifact:TPL-4",
        "org:artifact:DOC-5",
        "org:artifact:DOC-6",
        "malformed-room",
      ],
      "acme"
    );

    expect(liveblocksSecrets).toEqual(["sk_test-secret"]);
    expect(result).toEqual([
      {
        name: "PRD-1",
        roomId: "org:artifact:PRD-1",
        url: "/acme/prds/PRD-1",
      },
      {
        name: "ISS-2",
        roomId: "org:artifact:ISS-2",
        url: "/acme/issues/ISS-2",
      },
      {
        name: "PLN-3",
        roomId: "org:document:PLN-3",
        url: "/acme/implementation-plans/PLN-3",
      },
      { name: "TPL-4", roomId: "org:artifact:TPL-4", url: null },
      { name: "DOC-5", roomId: "org:artifact:DOC-5", url: null },
      { name: "DOC-6", roomId: "org:artifact:DOC-6", url: null },
      { name: "malformed-room", roomId: "malformed-room", url: null },
    ]);
    expect(mockGetRoom).toHaveBeenCalledTimes(6);
  });

  it("falls back to parsed slugs without making API calls when unconfigured", async () => {
    secrets.liveblocks = undefined;

    await expect(
      resolveRoomMetadata(["org:artifact:DOC-1", "org:document:DOC-2", "bad"])
    ).resolves.toEqual([
      { name: "DOC-1", roomId: "org:artifact:DOC-1", url: null },
      { name: "DOC-2", roomId: "org:document:DOC-2", url: null },
      { name: "bad", roomId: "bad", url: null },
    ]);
    expect(mockGetRoom).not.toHaveBeenCalled();
  });

  it("does not start a later batch until all ten current fetches finish", async () => {
    const roomIds = Array.from(
      { length: 11 },
      (_, index) => `org:artifact:DOC-${index + 1}`
    );
    const pendingRooms = roomIds.map(() => deferredRoom());
    mockGetRoom.mockImplementation(
      (_roomId: string) =>
        pendingRooms[mockGetRoom.mock.calls.length - 1].promise
    );

    const resultPromise = resolveRoomMetadata(roomIds);
    await vi.waitFor(() => expect(mockGetRoom).toHaveBeenCalledTimes(10));

    for (const pending of pendingRooms.slice(0, 10)) {
      pending.resolve({ metadata: { documentType: DocumentType.Doc } });
    }
    await vi.waitFor(() => expect(mockGetRoom).toHaveBeenCalledTimes(11));
    pendingRooms[10].resolve({
      metadata: { documentType: DocumentType.Doc },
    });

    const result = await resultPromise;
    expect(result).toHaveLength(11);
    expect(result.map(({ roomId }) => roomId)).toEqual(roomIds);
  });
});

function deferredRoom() {
  let resolve!: (room: { metadata: { documentType: DocumentType } }) => void;
  const promise = new Promise<{ metadata: { documentType: DocumentType } }>(
    (resolvePromise) => {
      resolve = resolvePromise;
    }
  );
  return { promise, resolve };
}
