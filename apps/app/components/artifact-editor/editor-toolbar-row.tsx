import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

type EditorToolbarRowProps = {
  leftContent?: ReactNode;
  rightContent?: ReactNode;
  className?: string;
};

export function EditorToolbarRow({
  leftContent,
  rightContent,
  className,
}: EditorToolbarRowProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 border-b bg-background px-4 py-2",
        className
      )}
    >
      <div className="flex items-center gap-2">{leftContent}</div>
      <div className="flex items-center gap-2">{rightContent}</div>
    </div>
  );
}
