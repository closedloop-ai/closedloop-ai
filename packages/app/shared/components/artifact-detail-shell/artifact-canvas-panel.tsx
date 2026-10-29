"use client";

import type { ReactNode, Ref } from "react";
import { ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS } from "./artifact-detail-shell";
import { ArtifactTab } from "./artifact-tab";

/**
 * ISS-12403: a tab body on the Artifact tab's framed canvas (a muted surround,
 * one bordered card) at the page's one content width. The Session/Artifact,
 * Details and Activity tabs of the Session and Branch pages all use it
 * (ISS-12412), so every tab reads as the same card.
 *
 * The card is the one scroll container (`ArtifactTab`'s own), and `scrollRef`
 * hands it to a canvas that jumps to a row (the session trace), so the jump
 * measures the element the user scrolls. A canvas that already owns its
 * scroller and sticky header (`fill`: the production Session workspace) fills
 * the card unpadded instead, so the card never scrolls around it.
 */
export function ArtifactCanvasPanel({
  children,
  fill = false,
  label,
  scrollRef,
}: {
  children: ReactNode;
  fill?: boolean;
  /** The card's accessible name. */
  label: string;
  scrollRef?: Ref<HTMLElement>;
}) {
  return (
    <div
      className={`flex min-h-0 w-full ${ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS} flex-1 flex-col`}
    >
      <ArtifactTab
        canvas={
          <div
            className={fill ? "flex min-h-0 flex-1 flex-col" : "px-5 pt-4 pb-6"}
          >
            {children}
          </div>
        }
        label={label}
        scrollRef={scrollRef}
      />
    </div>
  );
}
