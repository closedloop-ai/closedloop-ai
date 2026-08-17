"use client";

import type { ReactNode } from "react";

type InlineEditEditorShellProps = {
  expanded: boolean;
  toolbar: ReactNode;
  children: ReactNode;
};

/**
 * Wraps an inline-editable body with the toolbar it shows while expanded.
 *
 * The shell never scrolls: both states size to their content so whichever
 * page-level container hosts the shell stays the single scroll region. A
 * clamped, internally-scrolling read state nests a second scroll container
 * inside that page scroller, which macOS Chrome renders as two scrollbars
 * side by side, and makes the page reflow every time the user enters or
 * leaves edit mode.
 *
 * It also draws no bottom edge. The shell is full-bleed while hosts typically
 * cap the body at a reading measure, so a rule here would run wider than the
 * content on both sides of it. Whatever follows the shell owns that seam.
 *
 * No min-height either: the editable body it wraps carries its own floor, so
 * declaring one here only duplicates it in a second place.
 */
export function InlineEditEditorShell({
  expanded,
  toolbar,
  children,
}: Readonly<InlineEditEditorShellProps>) {
  return (
    <>
      {expanded ? toolbar : null}
      <div className="flex flex-col">{children}</div>
    </>
  );
}
