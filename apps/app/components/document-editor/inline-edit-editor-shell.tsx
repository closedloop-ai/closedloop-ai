"use client";

import type { ReactNode } from "react";

type InlineEditEditorShellProps = {
  isEditing: boolean;
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
  isEditing,
  toolbar,
  children,
}: Readonly<InlineEditEditorShellProps>) {
  return (
    <>
      {isEditing ? toolbar : null}
      <div
        className={
          isEditing
            ? "flex min-h-[200px] flex-col"
            : "flex max-h-[420px] flex-col overflow-hidden"
        }
      >
        {children}
      </div>
    </>
  );
}
