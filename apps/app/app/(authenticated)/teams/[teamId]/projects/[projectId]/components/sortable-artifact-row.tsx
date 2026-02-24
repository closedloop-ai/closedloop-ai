"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { TableRow } from "@repo/design-system/components/ui/table";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

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
  const [isHovered, setIsHovered] = useState(false);

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

  const showCheckbox = (selectedIds?.size ?? 0) > 0 || isHovered;

  return (
    <TableRow
      className={`${className} data-[state=dragging]:opacity-50`}
      data-state={isDragging ? "dragging" : undefined}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      ref={setNodeRef}
      style={style}
    >
      <td className="w-8 px-2">
        {showCheckbox ? (
          <Checkbox
            aria-label={`Select ${artifact.title}`}
            checked={selectedIds?.has(artifact.id)}
            onCheckedChange={(checked) =>
              onSelectChange?.(artifact.id, !!checked)
            }
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
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
        )}
      </td>
      {children}
    </TableRow>
  );
}
