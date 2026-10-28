"use client";

import { ArtifactActivityPanel } from "@repo/app/documents/components/artifact-activity/artifact-activity-panel";
import type { ArtifactCommentAddress } from "@repo/app/documents/components/artifact-activity/artifact-activity-rows";
import { ActivityArtifactKind } from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import { useSessionActivityFeed } from "../../hooks/use-session-activity-feed";

/**
 * The Session Activity tab (ISS-11004): the shared timeline over live rows —
 * stored activity events and the session's comments in one stream.
 *
 * Comments arrive in the feed itself since ISS-11004, so this panel reads one
 * source and maps it. `buildCommentHref` stays the host's: the href needs the
 * navigation port, which throws without a provider, and this panel is mounted
 * bare by tests and stories — the same reason the host already supplies
 * `buildTranscriptFileHref` and `buildArtifactHref`.
 *
 * A Session has ONE comments rail, in its Sessions panel, so the host ignores
 * the address's `surface`; Branch is the surface that routes on it.
 */
export function SessionShellActivity({
  buildCommentHref,
  sessionId,
}: Readonly<{
  buildCommentHref: (address: ArtifactCommentAddress) => string;
  sessionId: string;
}>) {
  const feed = useSessionActivityFeed(sessionId);
  return (
    <ArtifactActivityPanel
      artifactKind={ActivityArtifactKind.Session}
      buildCommentHref={buildCommentHref}
      feed={feed}
    />
  );
}
