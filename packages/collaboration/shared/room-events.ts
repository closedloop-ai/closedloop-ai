/**
 * Custom Liveblocks room event types broadcast by the server to all
 * connected clients in a document room. See `config.ts` for the
 * corresponding global `Liveblocks.RoomEvent` declaration.
 */
export const RoomEventType = {
  /**
   * The Liveblocks reset protocol: sent after a new document version is
   * published and `resetDocumentRoom` clears the Liveblocks room. A Liveblocks
   * editor refetches the new version and reseeds the room without going
   * blank. Every editor learns of the version from the `version.published`
   * realtime signal; doc-sync never carries this event (PLN-2190).
   */
  DocumentVersionPublished: "document-version-published",
} as const;
export type RoomEventType = (typeof RoomEventType)[keyof typeof RoomEventType];

/**
 * Payload broadcast when a new document version is published.
 *
 * `publisherId` is the platform user id (not Clerk id) of the user who
 * triggered the publish, or `null` for system-driven version bumps. It is
 * retained for attribution/diagnostics only; clients do NOT dedupe on it. A
 * user id is too coarse to identify the originating client (a headless MCP
 * agent acting as the user shares the id but is a different client), so every
 * connected client reacts to the event and idempotency is enforced per-version
 * on the receiving side instead. See `useDocumentRoomEvents` in `apps/app`.
 */
export type DocumentVersionPublishedEvent = {
  type: typeof RoomEventType.DocumentVersionPublished;
  version: number;
  publisherId: string | null;
  publishedAt: string;
};
