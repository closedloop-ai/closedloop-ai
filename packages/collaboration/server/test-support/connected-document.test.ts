import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectedDocumentProviderError,
  cleanupConnectedDocumentRoom,
  connectedDocumentFailure,
} from "../../shared/connected-document-failure";
import {
  cleanupConnectedDocument,
  connectedDocumentWitness,
} from "./connected-document";

const mocks = vi.hoisted(() => {
  class MissingRoom extends Error {
    readonly status: number;

    constructor(status = 404) {
      super("SDK response body must not reach the provider marker");
      this.status = status;
    }
  }
  return {
    MissingRoom,
    createRoom: vi.fn(),
    getRoom: vi.fn(),
    deleteRoom: vi.fn(),
    prepareSession: vi.fn(),
    allow: vi.fn(),
    authorize: vi.fn(),
  };
});
vi.mock("@liveblocks/node", () => ({
  Liveblocks: class {
    createRoom = mocks.createRoom;
    getRoom = mocks.getRoom;
    deleteRoom = mocks.deleteRoom;
    prepareSession = mocks.prepareSession;
  },
  LiveblocksError: mocks.MissingRoom,
}));

const IDENTITY = {
  organizationId: "test-org",
  slug: "DOC-test-run",
  documentId: "test-document",
};
const SECRET_BEFORE = process.env.LIVEBLOCKS_SECRET;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.LIVEBLOCKS_SECRET = "sk_test_qualification";
  mocks.getRoom.mockResolvedValue({
    organizationId: IDENTITY.organizationId,
    metadata: { documentId: IDENTITY.documentId },
  });
  mocks.prepareSession.mockReturnValue({
    FULL_ACCESS: ["room:write"],
    allow: mocks.allow,
    authorize: mocks.authorize,
  });
  mocks.authorize.mockResolvedValue({ status: 200, body: "test-auth-payload" });
});
afterEach(() => {
  if (SECRET_BEFORE === undefined) {
    Reflect.deleteProperty(process.env, "LIVEBLOCKS_SECRET");
  } else {
    process.env.LIVEBLOCKS_SECRET = SECRET_BEFORE;
  }
});

describe("run-owned real-room witness", () => {
  it("fails on missing or dummy configuration instead of claiming connection", () => {
    Reflect.deleteProperty(process.env, "LIVEBLOCKS_SECRET");
    expect(() => connectedDocumentWitness(IDENTITY)).toThrow(
      "configured staging"
    );
    process.env.LIVEBLOCKS_SECRET = "sk_e2elocaldummysecretchangeme0123456789";
    expect(() => connectedDocumentWitness(IDENTITY)).toThrow(
      "configured staging"
    );
    expect(mocks.createRoom).not.toHaveBeenCalled();
  });
  it("creates a private room and authorizes only that exact room", async () => {
    const witness = await connectedDocumentWitness(IDENTITY);
    await witness.create();
    expect(mocks.createRoom).toHaveBeenCalledWith(
      "test-org:artifact:DOC-test-run",
      {
        defaultAccesses: [],
        tenantId: "test-org",
        metadata: { documentId: "test-document" },
        engine: 2,
      }
    );
    expect(await witness.authorize("test-user")).toEqual({
      status: 200,
      body: "test-auth-payload",
    });
    expect(mocks.allow).toHaveBeenCalledWith(witness.roomId, ["room:write"]);
  });
  it("refuses to authorize or delete a foreign tenant's room", async () => {
    mocks.getRoom.mockResolvedValue({
      organizationId: "foreign-org",
      metadata: { documentId: IDENTITY.documentId },
    });
    const witness = await connectedDocumentWitness(IDENTITY);
    await expect(witness.authorize("test-user")).rejects.toThrow(
      "does not belong"
    );
    await expect(witness.delete()).rejects.toThrow("does not belong");
    expect(mocks.prepareSession).not.toHaveBeenCalled();
    expect(mocks.deleteRoom).not.toHaveBeenCalled();
  });
  it("refuses a different document in the same tenant", async () => {
    mocks.getRoom.mockResolvedValue({
      organizationId: IDENTITY.organizationId,
      metadata: { documentId: "foreign-document" },
    });
    const witness = await connectedDocumentWitness(IDENTITY);
    await expect(witness.delete()).rejects.toThrow("does not belong");
    expect(mocks.deleteRoom).not.toHaveBeenCalled();
  });
  it("requires observed remote absence after deletion", async () => {
    const witness = await connectedDocumentWitness(IDENTITY);
    await expect(witness.delete()).rejects.toThrow("still exists");
    mocks.getRoom.mockRejectedValue(new mocks.MissingRoom());
    await expect(witness.assertDeleted()).resolves.toBeUndefined();
  });
  it("propagates remote cleanup and verification failures", async () => {
    mocks.deleteRoom.mockRejectedValueOnce(new Error("cleanup failed"));
    const witness = await connectedDocumentWitness(IDENTITY);
    await expect(witness.delete()).rejects.toThrow("cleanup failed");
    mocks.getRoom.mockRejectedValueOnce(new Error("verification failed"));
    await expect(witness.assertDeleted()).rejects.toThrow(
      "verification failed"
    );
  });
});

describe("owned document cleanup completion", () => {
  it("continues deletion and both absence checks after failed disconnection and deletion", async () => {
    const primary = new Error("qualification failed");
    const disconnectError = new Error("renderer unavailable");
    const deleteError = new Error("deletion rejected");
    const actions = {
      disconnect: vi.fn().mockRejectedValue(disconnectError),
      deleteDocument: vi.fn().mockRejectedValue(deleteError),
      assertDocumentAbsent: vi.fn().mockResolvedValue(undefined),
      assertRoomAbsent: vi.fn().mockResolvedValue(undefined),
    };
    let observed: unknown;
    try {
      await cleanupConnectedDocument(actions, [primary]);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) {
      throw new Error("Cleanup lost its aggregate failure");
    }
    expect(observed.errors).toEqual([primary, disconnectError, deleteError]);
    expect(actions.disconnect).toHaveBeenCalledOnce();
    expect(actions.deleteDocument).toHaveBeenCalledOnce();
    expect(actions.assertDocumentAbsent).toHaveBeenCalledOnce();
    expect(actions.assertRoomAbsent).toHaveBeenCalledOnce();
  });
  it("requires document and room absence even when deletion reported success", async () => {
    const documentError = new Error("document persists");
    const roomError = new Error("room persists");
    const actions = {
      disconnect: vi.fn().mockResolvedValue(undefined),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      assertDocumentAbsent: vi.fn().mockRejectedValue(documentError),
      assertRoomAbsent: vi.fn().mockRejectedValue(roomError),
    };
    let observed: unknown;
    try {
      await cleanupConnectedDocument(actions, []);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) {
      throw new Error("Cleanup swallowed persistence failures");
    }
    expect(observed.errors).toEqual([documentError, roomError]);
  });
});

describe("SDK provider failure boundary", () => {
  it.each([500, 502, 503, 504])(
    "sanitizes typed transient SDK status %s at the actual create caller",
    async (status) => {
      mocks.createRoom.mockRejectedValue(new mocks.MissingRoom(status));
      const witness = connectedDocumentWitness(IDENTITY);
      await expect(witness.create()).rejects.toBeInstanceOf(
        ConnectedDocumentProviderError
      );
      await expect(witness.create()).rejects.not.toThrow("SDK response body");
    }
  );
  it.each([400, 401, 403, 404, 409, 422, 501])(
    "preserves terminal SDK status %s",
    async (status) => {
      const error = new mocks.MissingRoom(status);
      mocks.createRoom.mockRejectedValue(error);
      await expect(connectedDocumentWitness(IDENTITY).create()).rejects.toBe(
        error
      );
    }
  );
  it("requires a known transport code instead of a generic fetch message or status object", async () => {
    const transport = Object.assign(new Error("private transport detail"), {
      code: "ECONNRESET",
    });
    mocks.getRoom.mockRejectedValueOnce(
      new TypeError("fetch failed", { cause: transport })
    );
    await expect(
      connectedDocumentWitness(IDENTITY).verifyOwnership()
    ).rejects.toBeInstanceOf(ConnectedDocumentProviderError);
    for (const error of [
      new TypeError("fetch failed"),
      { status: 503 },
      new Error("editor assertion failed"),
      Object.assign(new Error("transport"), {
        code: "ECONNRESET",
        cause: new Error("assertion"),
      }),
    ]) {
      mocks.getRoom.mockRejectedValueOnce(error);
      await expect(
        connectedDocumentWitness(IDENTITY).verifyOwnership()
      ).rejects.toBe(error);
    }
  });
  it("classifies the SDK authorize response, without reclassifying auth denials", async () => {
    const witness = connectedDocumentWitness(IDENTITY);
    mocks.authorize.mockResolvedValueOnce({
      status: 503,
      body: "private SDK detail",
      error: Object.assign(new Error("network"), { code: "ETIMEDOUT" }),
    });
    await expect(witness.authorize("test-user")).rejects.toBeInstanceOf(
      ConnectedDocumentProviderError
    );
    const unknown = new Error("SDK internal failure");
    mocks.authorize.mockResolvedValueOnce({
      status: 503,
      body: "generic SDK fallback",
      error: unknown,
    });
    await expect(witness.authorize("test-user")).rejects.toBe(unknown);
    mocks.authorize.mockResolvedValueOnce({
      status: 503,
      body: "HTTP unavailable",
    });
    await expect(witness.authorize("test-user")).rejects.toBeInstanceOf(
      ConnectedDocumentProviderError
    );
    for (const status of [401, 403]) {
      mocks.authorize.mockResolvedValueOnce({ status, body: "denied" });
      await expect(witness.authorize("test-user")).resolves.toEqual({
        status,
        body: "denied",
      });
    }
  });
  it("propagates a provider-only owned cleanup aggregate and preserves an independent assertion", async () => {
    const witness = connectedDocumentWitness(IDENTITY);
    mocks.deleteRoom.mockRejectedValue(new mocks.MissingRoom(503));
    const actions = {
      disconnect: async () => undefined,
      deleteDocument: () => witness.delete(),
      assertDocumentAbsent: async () => undefined,
      assertRoomAbsent: async () => undefined,
    };
    const primary = new Error("editor assertion failed");
    await expect(cleanupConnectedDocument(actions, [])).rejects.toThrow(
      new ConnectedDocumentProviderError().message
    );
    await expect(cleanupConnectedDocument(actions, [primary])).rejects.toThrow(
      "owned cleanup failed"
    );
    expect(
      connectedDocumentFailure(
        [new ConnectedDocumentProviderError(), primary],
        "hard"
      ).message
    ).toBe("hard");
  });
});

describe("real witness room cleanup caller", () => {
  it("retains registered ownership-check failure and an independently observed remaining room", async () => {
    const witness = connectedDocumentWitness(IDENTITY);
    await witness.create();
    mocks.getRoom.mockRejectedValueOnce(new mocks.MissingRoom(503));
    await expect(
      cleanupConnectedDocumentRoom(witness, true)
    ).rejects.toMatchObject({
      message: "Created room cleanup and absence verification failed",
      errors: [
        expect.any(ConnectedDocumentProviderError),
        expect.objectContaining({
          message: "Created test Liveblocks room still exists after cleanup",
        }),
      ],
    });
    expect(mocks.createRoom).toHaveBeenCalledOnce();
    expect(mocks.getRoom).toHaveBeenCalledTimes(3);
    expect(mocks.deleteRoom).not.toHaveBeenCalled();
  });

  it("preserves a transient SDK deletion failure and independently observed existing room", async () => {
    const witness = connectedDocumentWitness(IDENTITY);
    mocks.getRoom.mockRejectedValueOnce(new mocks.MissingRoom(503));
    await expect(
      cleanupConnectedDocumentRoom(witness, false)
    ).rejects.toMatchObject({
      message: "Partial room cleanup and absence verification failed",
      errors: [
        expect.any(ConnectedDocumentProviderError),
        expect.objectContaining({
          message: "Created test Liveblocks room still exists after cleanup",
        }),
      ],
    });
    expect(mocks.getRoom).toHaveBeenCalledTimes(2);
    expect(mocks.deleteRoom).not.toHaveBeenCalled();
  });

  it("settles an unregistered room only when the SDK confirms absence", async () => {
    const witness = connectedDocumentWitness(IDENTITY);
    mocks.getRoom.mockRejectedValue(new mocks.MissingRoom(404));
    await expect(
      cleanupConnectedDocumentRoom(witness, false)
    ).resolves.toBeUndefined();
    expect(mocks.getRoom).toHaveBeenCalledTimes(2);
    expect(mocks.deleteRoom).not.toHaveBeenCalled();
  });
});
