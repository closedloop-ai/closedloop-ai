import { describe, expect, it, vi } from "vitest";
import {
  CONNECTED_DOCUMENT_PROVIDER_FAILURE,
  ConnectedDocumentProviderError,
  cleanupConnectedDocumentRoom,
  connectedDocumentAuthorizationBoundary,
  connectedDocumentFailure,
} from "./connected-document-failure";

describe("connected document failure preservation", () => {
  it("marks only nonempty all-typed aggregates, including nested cleanup", () => {
    const provider = new ConnectedDocumentProviderError();
    const nested = connectedDocumentFailure([provider], "cleanup failed");
    expect(connectedDocumentFailure([provider, nested], "hard").message).toBe(
      CONNECTED_DOCUMENT_PROVIDER_FAILURE
    );
    for (const failure of [
      new Error("assertion"),
      new Error(CONNECTED_DOCUMENT_PROVIDER_FAILURE),
      undefined,
    ]) {
      const aggregate = connectedDocumentFailure([nested, failure], "hard");
      expect(aggregate.message).toBe("hard");
      expect(aggregate.errors).toEqual([nested, failure]);
    }
    expect(connectedDocumentFailure([], "hard").message).toBe("hard");
  });

  it("propagates the actual owned auth rejection before dependent readiness times out", async () => {
    const boundary = connectedDocumentAuthorizationBoundary();
    const provider = new ConnectedDocumentProviderError();
    const result = boundary.run(() => new Promise<never>(() => undefined));
    boundary.fail(provider);
    await expect(result).rejects.toBe(provider);
  });

  it("does not reinterpret an independent readiness failure or successful auth", async () => {
    const boundary = connectedDocumentAuthorizationBoundary();
    const assertion = new Error("editor did not become editable");
    await expect(boundary.run(() => Promise.reject(assertion))).rejects.toBe(
      assertion
    );
    await expect(boundary.run(() => Promise.resolve("ready"))).resolves.toBe(
      "ready"
    );
  });
});

describe("owned room cleanup", () => {
  it.each([false, true])(
    "retains deletion and hard absence errors together with created=%s",
    async (created) => {
      const deletion = new ConnectedDocumentProviderError();
      const absence = new Error("room still exists");
      const witness = {
        delete: vi.fn(() => Promise.reject(deletion)),
        assertDeleted: vi.fn(() => Promise.reject(absence)),
      };
      const result = cleanupConnectedDocumentRoom(witness, created);
      await expect(result).rejects.toMatchObject({
        message: created
          ? "Created room cleanup and absence verification failed"
          : "Partial room cleanup and absence verification failed",
        errors: [deletion, absence],
      });
      expect(witness.assertDeleted).toHaveBeenCalledOnce();
    }
  );

  it("settles partial creation only after observed absence", async () => {
    const witness = {
      delete: vi.fn(() => Promise.reject(new ConnectedDocumentProviderError())),
      assertDeleted: vi.fn(() => Promise.resolve()),
    };
    await expect(
      cleanupConnectedDocumentRoom(witness, false)
    ).resolves.toBeUndefined();
    expect(witness.assertDeleted).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps all-provider cleanup marked without discarding either failure with created=%s",
    async (created) => {
      const deletion = new ConnectedDocumentProviderError();
      const absence = new ConnectedDocumentProviderError();
      await expect(
        cleanupConnectedDocumentRoom(
          {
            delete: () => Promise.reject(deletion),
            assertDeleted: () => Promise.reject(absence),
          },
          created
        )
      ).rejects.toMatchObject({
        message: CONNECTED_DOCUMENT_PROVIDER_FAILURE,
        errors: [deletion, absence],
      });
    }
  );

  it("never settles a registered room's failed deletion through an absence fallback", async () => {
    const deletion = new Error("registered room deletion failed");
    const witness = {
      delete: vi.fn(() => Promise.reject(deletion)),
      assertDeleted: vi.fn(() => Promise.resolve()),
    };
    await expect(cleanupConnectedDocumentRoom(witness, true)).rejects.toBe(
      deletion
    );
    expect(witness.assertDeleted).toHaveBeenCalledOnce();
  });

  it("does not duplicate the successful witness deletion's own absence check", async () => {
    const witness = {
      delete: vi.fn(() => Promise.resolve()),
      assertDeleted: vi.fn(() => Promise.resolve()),
    };
    await expect(
      cleanupConnectedDocumentRoom(witness, true)
    ).resolves.toBeUndefined();
    expect(witness.delete).toHaveBeenCalledOnce();
    expect(witness.assertDeleted).not.toHaveBeenCalled();
  });
});
