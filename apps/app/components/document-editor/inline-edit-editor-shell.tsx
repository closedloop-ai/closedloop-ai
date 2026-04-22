"use client";

import type { ReactNode } from "react";

type InlineEditEditorShellProps = {
  isEditing: boolean;
  onEnterEditMode: () => void;
  toolbar: ReactNode;
  children: ReactNode;
};

/**
 * Shared chrome for document editors that start in read-only mode and expand
 * to an edit layout when the user clicks the editor surface. Host components
 * drive the state via `useInlineEditMode` and pass the toolbar + editor as
 * slots, keeping their own function bodies under Biome's cognitive complexity
 * ceiling.
 */
export function InlineEditEditorShell({
  isEditing,
  onEnterEditMode,
  toolbar,
  children,
}: Readonly<InlineEditEditorShellProps>) {
  return (
    <>
      {isEditing ? toolbar : null}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit wrapper; keyboard users enter edit mode by focusing the editor directly */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above */}
      <div
        className={
          isEditing
            ? "flex min-h-[200px] flex-col"
            : "flex max-h-[420px] cursor-text flex-col overflow-hidden"
        }
        onClick={onEnterEditMode}
      >
        {children}
      </div>
    </>
  );
}
