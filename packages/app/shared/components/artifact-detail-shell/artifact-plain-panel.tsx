"use client";

import type { ReactNode } from "react";

/**
 * The content width of every tab body but Artifact's (Nerys, 2026-10-22):
 * left-aligned, never centred, capped at 1200px. The Sessions & timeline
 * panel's `.bq-sessions-main` (packages/app/styles.css) holds the same cap
 * and padding, so every
 * non-Artifact tab's content starts and ends in the same place. The Artifact
 * tab's card keeps its own width (`ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS`).
 */
export const ARTIFACT_TAB_BODY_WIDTH_CLASS = "max-w-[1200px]";

/** The Activity tab's title (Nerys, 2026-10-22). */
export const ACTIVITY_TIMELINE_TITLE = "Activity timeline";

/**
 * The padding every non-Artifact tab body shares: 20px sides, 24px below,
 * and 12px above, which with a title row's own 4px puts every tab's first
 * title 16px down, level with the Sessions tab's timeline title.
 */
export const ARTIFACT_TAB_BODY_PADDING_CLASS = "px-5 pt-3 pb-6";

/**
 * A tab body with no canvas card (Nerys, 2026-10-22): the page's own
 * background, the content left-aligned and capped at 1200px. Every tab but
 * Artifact uses it, so only the artifact itself sits on the framed canvas
 * (`ArtifactCanvasPanel`).
 *
 * It is the scroll container, and a labelled region, as the card was.
 */
export function ArtifactPlainPanel({
  children,
  label,
}: Readonly<{
  children: ReactNode;
  /** The region's accessible name. */
  label: string;
}>) {
  return (
    <section
      aria-label={label}
      className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto"
    >
      <div
        className={`w-full ${ARTIFACT_TAB_BODY_WIDTH_CLASS} ${ARTIFACT_TAB_BODY_PADDING_CLASS}`}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * A non-Artifact tab's titled body: the title styled as the Details tab's group titles and
 * the Sessions tab's timeline title (13px semibold), so every such tab opens
 * on the same kind of subtitle.
 */
export function ArtifactTabSection({
  children,
  title,
}: Readonly<{ children: ReactNode; title: string }>) {
  return (
    <div>
      <div className="flex items-baseline gap-2 py-1">
        <h2 className="font-semibold text-sm">{title}</h2>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
