"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { TableRow } from "@repo/design-system/components/ui/table";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";

type SortableArtifactRowProps = {
  artifact: ArtifactWithWorkstream;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  selectedIds?: Set<string>;
  onSelectChange?: (id: string, checked: boolean) => void;
};

export function SortableArtifactRow({
  artifact,
  children,
  onClick,
  className,
  selectedIds,
  onSelectChange,
}: SortableArtifactRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: artifact.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const hasSelections = (selectedIds?.size ?? 0) > 0;

  return (
    <TableRow
      className={`group ${className} data-[state=dragging]:opacity-50`}
      data-state={isDragging ? "dragging" : undefined}
      onClick={onClick}
      ref={setNodeRef}
      style={style}
    >
      <td className="w-10 px-2">
        <div className="flex items-center gap-1">
          <Checkbox
            aria-label={`Select ${artifact.title}`}
            checked={selectedIds?.has(artifact.id)}
            className={
              hasSelections
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100"
            }
            onCheckedChange={(checked) =>
              onSelectChange?.(artifact.id, !!checked)
            }
            onClick={(e) => e.stopPropagation()}
            tabIndex={hasSelections ? 0 : -1}
          />
          <button
            className={`cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing ${hasSelections ? "hidden" : ""}`}
            onClick={(e) => e.stopPropagation()}
            type="button"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
            <span className="sr-only">Drag to reorder</span>
          </button>
        </div>
      </td>
      {children}
    </TableRow>
  );
}
