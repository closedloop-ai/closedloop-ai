"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TableRow } from "@repo/design-system/components/ui/table";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";

type SortableTableRowProps = {
  id: string;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
};

export function SortableTableRow({
  id,
  children,
  onClick,
  className,
}: SortableTableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <TableRow
      className={`${className ?? ""} data-[state=dragging]:opacity-50`}
      data-state={isDragging ? "dragging" : undefined}
      onClick={onClick}
      ref={setNodeRef}
      style={style}
    >
      <td className="w-8 px-2">
        <button
          className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
          type="button"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
          <span className="sr-only">Drag to reorder</span>
        </button>
      </td>
      {children}
    </TableRow>
  );
}
