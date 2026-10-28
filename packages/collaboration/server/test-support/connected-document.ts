import { Liveblocks, LiveblocksError } from "@liveblocks/node";
import { withProsemirrorDocument } from "@liveblocks/node-prosemirror";
import { z } from "zod";
import {
  ConnectedDocumentProviderError,
  connectedDocumentFailure,
} from "../../shared/connected-document-failure";
import { keys } from "../keys";
import "../../shared/config";
import { generateDocumentRoomId } from "../../shared/room-utils";

type DocumentIdentity = {
  organizationId: string;
  slug: string;
  documentId: string;
};

/** A server-side witness of the real remote Y.Doc, never a renderer-seeded readiness flag. */
export function connectedDocumentWitness(identity: DocumentIdentity) {
  const secret = keys().LIVEBLOCKS_SECRET;
  if (!secret || secret.includes("dummysecret")) {
    throw new Error(
      "Liveblocks qualification requires the configured staging project secret"
    );
  }
  const client = new Liveblocks({ secret });
  const roomId = generateDocumentRoomId(identity.organizationId, identity.slug);
  const verifyOwnership = async () => {
    const room = await witnessOperation(() => client.getRoom(roomId));
    if (
      room.organizationId !== identity.organizationId ||
      room.metadata.documentId !== identity.documentId
    ) {
      throw new Error(
        "Liveblocks room does not belong to the created test document"
      );
    }
  };
  return {
    roomId,
    verifyOwnership,
    async create() {
      await witnessOperation(() =>
        client.createRoom(roomId, {
          defaultAccesses: [],
          tenantId: identity.organizationId,
          metadata: { documentId: identity.documentId },
          engine: 2,
        })
      );
      await verifyOwnership();
    },
    async authorize(userId: string) {
      await verifyOwnership();
      const session = client.prepareSession(userId, {
        organizationId: identity.organizationId,
        userInfo: { name: "Rich text qualification", color: "#6366f1" },
      });
      // This test principal can mutate only this run-owned room, not an org wildcard.
      session.allow(roomId, session.FULL_ACCESS);
      const authorization = await witnessOperation(() => session.authorize());
      if (authorization.error !== undefined) {
        if (isTransientProviderError(authorization.error)) {
          throw new ConnectedDocumentProviderError();
        }
        throw authorization.error;
      }
      if (TRANSIENT_PROVIDER_STATUSES.has(authorization.status)) {
        throw new ConnectedDocumentProviderError();
      }
      return authorization;
    },
    async seed(text: string) {
      await verifyOwnership();
      await witnessOperation(() =>
        withProsemirrorDocument({ roomId, client }, (document) =>
          document.setContent({
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          })
        )
      );
    },
    async snapshot() {
      await verifyOwnership();
      return await witnessOperation(() =>
        withProsemirrorDocument({ roomId, client }, (document) => {
          const marks: Array<{ text: string; types: string[] }> = [];
          document.getEditorState().doc.descendants((node) => {
            if (node.isText && node.text) {
              marks.push({
                text: node.text,
                types: node.marks.map((mark) => mark.type.name),
              });
            }
          });
          return { text: document.getText(), marks };
        })
      );
    },
    async delete() {
      await verifyOwnership();
      await witnessOperation(() => client.deleteRoom(roomId));
      await assertRoomAbsent(client, roomId);
    },
    async assertDeleted() {
      await assertRoomAbsent(client, roomId);
    },
  };
}

async function assertRoomAbsent(
  client: Liveblocks,
  roomId: string
): Promise<void> {
  try {
    await witnessOperation(() => client.getRoom(roomId));
  } catch (error) {
    if (error instanceof LiveblocksError && error.status === 404) {
      return;
    }
    throw error;
  }
  throw new Error("Created test Liveblocks room still exists after cleanup");
}

/** Complete every owned teardown even after disconnection fails, preserving the qualification error. */
export async function cleanupConnectedDocument(
  actions: {
    disconnect: () => Promise<void>;
    deleteDocument: () => Promise<void>;
    assertDocumentAbsent: () => Promise<void>;
    assertRoomAbsent: () => Promise<void>;
  },
  primaryFailures: readonly unknown[]
): Promise<void> {
  const failures = [...primaryFailures];
  for (const action of [
    actions.disconnect,
    actions.deleteDocument,
    actions.assertDocumentAbsent,
    actions.assertRoomAbsent,
  ]) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw connectedDocumentFailure(
      failures,
      "Liveblocks qualification or owned cleanup failed"
    );
  }
}

// The SDK returns HTTP failures as LiveblocksError, but fetch failures retain the transport cause.
const TRANSIENT_PROVIDER_STATUSES: ReadonlySet<number> = new Set([
  500, 502, 503, 504,
]);
const TRANSIENT_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TransportErrorSchema = z.object({
  code: z.string().optional(),
  cause: z.unknown().optional(),
});

/** SDK operations alone may emit the sanitized provider marker; caller assertions stay outside. */
async function witnessOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isTransientProviderError(error)) {
      throw new ConnectedDocumentProviderError();
    }
    throw error;
  }
}

function isTransientProviderError(error: unknown): boolean {
  if (error instanceof LiveblocksError) {
    return TRANSIENT_PROVIDER_STATUSES.has(error.status);
  }
  // An HTTP-looking plain object, generic fetch error, or arbitrary assertion is not transport evidence.
  if (!(error instanceof Error)) {
    return false;
  }
  const parsed = TransportErrorSchema.safeParse(error);
  if (!parsed.success) {
    return false;
  }
  if (parsed.data.code !== undefined) {
    return (
      TRANSIENT_TRANSPORT_CODES.has(parsed.data.code) &&
      parsed.data.cause === undefined
    );
  }
  const cause = parsed.data.cause;
  if (!(cause instanceof Error)) {
    return false;
  }
  const nested = TransportErrorSchema.safeParse(cause);
  return (
    nested.success &&
    nested.data.code !== undefined &&
    nested.data.cause === undefined &&
    TRANSIENT_TRANSPORT_CODES.has(nested.data.code)
  );
}
