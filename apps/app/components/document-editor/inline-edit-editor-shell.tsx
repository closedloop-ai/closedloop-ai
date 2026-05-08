"use client";

import type { ReactNode } from "react";

type InlineEditEditorShellProps = {
  /**
   * When true: render the toolbar and let the editor body grow to fit its
   * content. When false: hide the toolbar and clamp the body to a preview
   * height. Hosts typically pass `isEditing || isViewingHistorical` so
   * historical views keep the version selector and restore action visible.
   */
  expanded: boolean;
  toolbar: ReactNode;
  children: ReactNode;
};

/**
 * Shared chrome for document editors that start in read-only mode and expand
 * to an edit layout when the editor body is clicked. Hosts wire click-to-edit
 * directly onto the editor body (e.g. via `onBodyClick`) so clicks on the
 * header (title, metadata bar) don't trigger edit mode.
 */
export function InlineEditEditorShell({
  expanded,
  toolbar,
  children,
}: Readonly<InlineEditEditorShellProps>) {
  return (
    <>
      {expanded ? toolbar : null}
      <div
        className={
          expanded
            ? "flex min-h-[200px] flex-col border-b"
            : "flex max-h-[72vh] flex-col overflow-hidden border-b"
        }
      >
        {children}
      </div>
    </>
  );
}
