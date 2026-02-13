"use client";

import { useDroppable } from "@dnd-kit/core";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

type DroppableProjectItemProps = {
  projectId: string;
  children: ReactNode;
};

export function DroppableProjectItem({
  projectId,
  children,
}: DroppableProjectItemProps) {
  const { isOver, setNodeRef } = useDroppable({ id: projectId });

  return (
    <div
      className={cn(
        "transition-colors",
        isOver && "border-primary border-l-2 bg-accent"
      )}
      ref={setNodeRef}
    >
      {children}
    </div>
  );
}
