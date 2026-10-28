import { z } from "zod";

export const DocSyncTokenErrorCode = {
  /** No token signer, or no `DOC_SYNC_PUBLIC_URL`, so no usable token can be issued. */
  NotConfigured: "doc_sync_not_configured",
  /** The room is not the canonical `{orgId}:artifact:{slug}` id of a stored slug. */
  InvalidRoom: "invalid_room",
  DocumentNotFound: "document_not_found",
} as const;
export type DocSyncTokenErrorCode =
  (typeof DocSyncTokenErrorCode)[keyof typeof DocSyncTokenErrorCode];

/** Structured log event emitted once per minted token; never carries the token. */
export const DOC_SYNC_TOKEN_ISSUED_EVENT = "doc_sync.token.issued";

export const docSyncTokenRequestSchema = z.object({
  room: z.string().min(1),
});
