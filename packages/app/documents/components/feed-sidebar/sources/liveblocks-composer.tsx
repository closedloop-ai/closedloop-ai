"use client";

import { Composer } from "@liveblocks/react-ui";
import { useLiveblocksSourceContext } from "./liveblocks-source-provider";

/**
 * Pinned composer at the bottom of the FeedSidebar Feed tab. Creates an
 * artifact-level Liveblocks thread (no Y.Doc anchor, no `anchorPreview`
 * in metadata). Submission goes through Liveblocks's client SDK; the
 * `handleThreadCreated` webhook in `apps/api/app/webhooks/liveblocks/`
 * upserts the DB row. No server route is involved in this path.
 *
 * Must be mounted inside a `<RoomProvider>` (FeedSidebar is already
 * mounted inside `<OptionalDocumentRoom>` on the doc-editor side) and
 * inside a `<LiveblocksSourceProvider>` for `latestVersion`.
 */
export function LiveblocksComposer() {
  const { latestVersion } = useLiveblocksSourceContext();
  return (
    <div className="shrink-0 border-t bg-background p-3">
      <Composer
        className="lb-collab-artifact-composer"
        metadata={{ anchorStatus: "artifact-level", version: latestVersion }}
        overrides={{ COMPOSER_PLACEHOLDER: "Add a comment…" }}
        showAttachments
      />
    </div>
  );
}
