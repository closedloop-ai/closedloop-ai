"use client";

import { EditorBodyLoadFailure } from "@repo/app/documents/components/editor-body-load-failure";
import { useFeatureFlagGateOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DOCUMENT_EDITOR_STABLE_LOADING_REGION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useDocSyncRoom } from "@repo/collaboration/client/doc-sync-room";
import { Loader2Icon } from "lucide-react";
import { useRef } from "react";

export const EDITOR_LOADING_LABEL = "Loading editor";

type EditorBodyStatusRegionProps = {
  isEditorReady: boolean;
  hasTimedOut: boolean;
};

/**
 * Everything the content region shows *instead of* the editor body: the wait,
 * and the end of the wait. Kept together, and kept out of the scaffold, because
 * the states are mutually exclusive (ISS-7058).
 *
 * At most one of these is ever on screen: the spinner, or the timed-out state.
 */
export function EditorBodyStatusRegion({
  isEditorReady,
  hasTimedOut,
}: Readonly<EditorBodyStatusRegionProps>) {
  const { enabled: gateEnabled, isReady: gateSettled } =
    useFeatureFlagGateOptional(
      DOCUMENT_EDITOR_STABLE_LOADING_REGION_FEATURE_FLAG_KEY
    );
  // Latched to the gate's FIRST SETTLED answer, then never re-read. Both halves
  // are load-bearing and they fix opposite failures.
  //
  // SETTLED, not first-render. `useFeatureFlagEnabled` collapses "PostHog has
  // not answered yet" into `false`, and on web that answer arrives after mount,
  // so latching on the first render would pin the anonymous bootstrap's default
  // rather than this user's assignment — closed for a targeted user on every
  // real load, which is a gate that can never open (whitlockk, PR #6345).
  // `useFeatureFlagGateOptional` is the FEA-1626 mechanism for exactly that
  // distinction, and its deadline is why an unreachable flag service still
  // settles: past it the gate reads closed, which is the unflagged behavior.
  //
  // LATCHED, not live. Once settled, a later flip is ignored. Acting on one
  // would grow this region from ~216px to a full viewport mid-wait and push the
  // detail stack down by the difference — a shift of the very element the gate
  // exists to hold still, measured at 0.109 in Chromium on a document that
  // otherwise scores 0.000. The latch keeps the gate monotonic per load.
  const latchedGate = useRef<boolean | null>(null);
  if (latchedGate.current === null && gateSettled) {
    latchedGate.current = gateEnabled;
  }
  const reservesContentHeight = latchedGate.current ?? false;
  // A doc-sync room whose token mint was refused will never sync, and one whose
  // first-open seed is missing never reports synced (ISS-12508, PLN-2229
  // OQ-3), so waiting out the timeout only delays the same failure.
  const docSyncRoomFailed = useDocSyncRoom()?.failed ?? false;
  const hasGivenUpWaiting =
    !isEditorReady && (hasTimedOut || docSyncRoomFailed);
  return (
    <>
      <div
        aria-label={EDITOR_LOADING_LABEL}
        className={editorLoaderClassName(
          isEditorReady,
          hasGivenUpWaiting,
          reservesContentHeight
        )}
        role="status"
      >
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
      {hasGivenUpWaiting ? (
        <EditorBodyLoadFailure onRetry={reloadSurface} />
      ) : null}
    </>
  );
}

/**
 * The only recovery available for a document whose collaborative session never
 * connected: its auth and connect have both already been attempted, and nothing
 * short of a fresh load re-attempts them.
 */
function reloadSurface(): void {
  globalThis.location.reload();
}

/**
 * The loading spinner shows only while the editor is still coming up and the
 * wait has not timed out; the timed-out state already explains the region, so
 * a spinner under it is a second, contradictory claim.
 *
 * `reservesContentHeight` chooses the loader's HEIGHT and nothing else. It is
 * read after the suppressing states, never before, so reserving space can
 * never put a spinner over "the editor didn't load".
 */
export function editorLoaderClassName(
  isEditorReady: boolean,
  hasGivenUpWaiting = false,
  reservesContentHeight = false
): string {
  if (isEditorReady || hasGivenUpWaiting) {
    return "hidden";
  }
  const heightClass = reservesContentHeight
    ? EDITOR_LOADER_RESERVED_HEIGHT_CLASS
    : EDITOR_LOADER_INERT_HEIGHT_CLASS;
  return `flex ${heightClass} items-center justify-center py-24`;
}

/**
 * The editor is hidden rather than unmounted while it comes up, so the
 * Liveblocks room and content controller are already mounted the moment the
 * editor is ready.
 */
export function editorBodyClassName(
  isEditorReady: boolean
): string | undefined {
  if (!isEditorReady) {
    return "invisible h-0 overflow-hidden";
  }
  return undefined;
}

/**
 * What the loader has always claimed to do, and never did: its parent is the
 * Artifact tab canvas wrapper at `document-editor-scaffold.tsx`, a BLOCK box,
 * so `flex-1` on a child of it resolves against no flex line and the region
 * collapses to `py-24`. Kept as the flag-off spelling rather than deleted,
 * because removing it is the perceivable change and that ships behind the gate.
 */
const EDITOR_LOADER_INERT_HEIGHT_CLASS = "flex-1";

/**
 * ISS-8514. The same authorial intent expressed against the box that actually
 * contains the loader: the canvas wrapper is a `flex-1` item of the Artifact
 * tab's scroll container, so its height is definite after flexing and
 * `min-height: 100%` resolves to one viewport of the scroll area.
 *
 * While the editor is coming up its body is `invisible h-0` (see
 * {@link editorBodyClassName}), so `DocumentEditorDetails` — the element
 * production RUM names as the largest shift source on 91.8% of document views
 * over 0.1 CLS — sat ~216px down the container and then fell the full body
 * height the moment the editor mounted. Reserving the viewport put it at the
 * fold, so that displacement landed off-screen. Since #8686 (ISS-9403) the
 * stack is on the Details tab, which is not mounted while the Artifact tab
 * loads. What the gate is for since then is ISS-12725.
 */
const EDITOR_LOADER_RESERVED_HEIGHT_CLASS = "min-h-full";
