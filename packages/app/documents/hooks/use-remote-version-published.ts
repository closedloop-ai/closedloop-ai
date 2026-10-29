"use client";

import { DOC_SYNC_EDITOR_FLAG_KEY } from "@repo/api/src/types/doc-sync-editor-flag";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useRef } from "react";
import { useFeatureFlagEnabled } from "../../shared/feature-flags/use-feature-flag-enabled";

type UseRemoteVersionPublishedConfig = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
  setEditorContent: (content: string) => void;
};

/**
 * Reacts to a version another client published. When another client publishes
 * a new version (or a server generation pipeline completes), the Liveblocks
 * room event and the `version.published` realtime signal arrive. A user
 * viewing the previous latest advances to the new one. On Liveblocks the
 * editor is reseeded with the refetched content; on doc-sync the server
 * already seeded it, and it arrived as a Yjs sync.
 *
 * The version check is the one place a version is acted on once: the same
 * version arrives as both the room event and the signal, and the publishing
 * tab's own echo arrives after its mutation already advanced and toasted.
 */
export function useRemoteVersionPublished({
  document,
  currentVersion,
  onVersionChange,
  setEditorContent,
}: UseRemoteVersionPublishedConfig) {
  // The scaffold mounts `DocSyncRoom` from this flag; this hook runs above
  // that provider, so it reads the flag rather than the room (PLN-2190 T-3.1).
  const isOnDocSync = useFeatureFlagEnabled(DOC_SYNC_EDITOR_FLAG_KEY);
  // High-water mark of the newest version this client has already acted on —
  // either by publishing it locally or by handling a room event or signal.
  // Either can round-trip back before the parent's `useDocument` refetch
  // advances `document.latestVersion`, so the prop alone cannot recognize a
  // self-published version.
  const acknowledgedVersionRef = useRef(document.latestVersion);

  const acknowledgeVersion = useCallback((version: number) => {
    acknowledgedVersionRef.current = Math.max(
      acknowledgedVersionRef.current,
      version
    );
  }, []);

  const handleRemoteVersionPublished = useCallback(
    (updated: DocumentDetail) => {
      const knownVersion = Math.max(
        document.latestVersion,
        acknowledgedVersionRef.current
      );
      if (updated.latestVersion <= knownVersion) {
        return;
      }
      acknowledgedVersionRef.current = updated.latestVersion;
      const wasViewingLatest = currentVersion === document.latestVersion;
      if (wasViewingLatest) {
        onVersionChange(updated.latestVersion);
        if (!isOnDocSync) {
          setEditorContent(updated.version.content ?? "");
        }
      }
      toast(`A new version was published (v${updated.latestVersion}).`);
    },
    [
      currentVersion,
      document.latestVersion,
      isOnDocSync,
      onVersionChange,
      setEditorContent,
    ]
  );

  return { acknowledgeVersion, handleRemoteVersionPublished };
}
