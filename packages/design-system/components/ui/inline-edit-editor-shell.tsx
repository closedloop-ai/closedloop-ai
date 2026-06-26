"use client";

import type { ReactNode } from "react";

type InlineEditEditorShellProps = {
  expanded: boolean;
  toolbar: ReactNode;
  children: ReactNode;
};

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
