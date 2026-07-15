// Define Liveblocks types for your application
// https://liveblocks.io/docs/api-reference/liveblocks-react#Typing-your-data
import type { DocumentVersionPublishedEvent } from "./room-events";

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Liveblocks global augmentation requires `interface` for declaration merging.
  interface Liveblocks {
    // Each user's Presence, for useMyPresence, useOthers, etc.
    Presence: {
      /**
       * Marks a connection as a read-only viewer (e.g. historical-version
       * reader). `<Presence>` / `<InlinePresence>` filter these out so
       * historical-only readers do not show up in the live editors' avatar
       * stack. Undefined / false = live editor.
       */
      readOnly?: boolean;
    };

    // The Storage tree for the room, for useMutation, useStorage, etc.
    // Empty for Yjs-based collaboration: Yjs manages documents separately.
    Storage: Record<string, never>;

    // Custom user info set when authenticating with a secret key
    UserMeta: {
      id: string;
      info: {
        name?: string;
        avatar?: string;
        color: string;
      };
    };

    // Custom events, for useBroadcastEvent, useEventListener.
    // Event type strings come from `RoomEventType` in `./room-events`.
    RoomEvent: DocumentVersionPublishedEvent;

    // Custom metadata set on threads, for useThreads, useCreateThread, etc.
    ThreadMetadata: {
      /**
       * Snapshot of the text the thread was anchored to at creation time.
       * Set by the FloatingComposer wrapper from the editor selection.
       * Optional because legacy threads created before this field existed
       * won't have it.
       */
      anchorPreview?: string;
      /**
       * The artifact's `latestVersion` at the time this thread was created.
       * Stamped server-side by `handleThreadCreated` (Liveblocks webhook) and
       * by the explicit `createDocumentThread` POST path. Immutable for the
       * life of the thread. Used by the Feed sidebar to render a
       * "from v{N}" attribution badge once `latestVersion` advances past
       * this value, and as the filter key for the historical-version Feed.
       * Optional because legacy threads created before this field existed
       * won't have it.
       */
      version?: number;
      /**
       * Explicit discriminator for how the thread relates to the document:
       * - "anchored": the thread has a live `.lb-tiptap-thread-mark`
       *   decoration in the current Y.Doc and can be scrolled to.
       * - "floating": the thread was anchored on a prior version and was
       *   floated when a new version was published. No live decoration;
       *   render in the Feed sidebar only.
       * - "artifact-level": the thread was created from the Feed sidebar
       *   composer with no document selection. No anchor at all.
       *
       * Optional because legacy threads created before this field existed
       * won't have it. Consumers must fall back to the implicit signal:
       * `anchorPreview != null` → treat as "anchored", else "artifact-level".
       * The "floating" state is only ever set explicitly by the
       * Cross-Version Persistence floating-conversion pass.
       */
      anchorStatus?: "anchored" | "floating" | "artifact-level";
    };

    // Custom room info set with resolveRoomsInfo, for useRoomInfo
    RoomInfo: {
      name: string;
      url?: string;
    };

    // Custom activities data for inbox notifications
    ActivitiesData: {
      $assignment: {
        entityType: string;
        entityTitle: string;
        entityUrl: string;
        actorId: string;
      };
      // Fired when an autonomous Loop reaches terminal success, so the owner
      // gets an inbox signal that their agent finished even while they're away.
      $loopCompleted: {
        loopTitle: string;
        loopUrl: string;
      };
      // Fired when a run transitions into awaiting-input (blocked on the user),
      // so the owner gets an inbox signal with a deep link to unblock the run
      // from anywhere — even while they're away from the Active Runs panel.
      $awaitingInput: {
        sessionTitle: string;
        sessionUrl: string;
      };
    };
  }
}

export type { DocumentVersionPublishedEvent } from "./room-events";
