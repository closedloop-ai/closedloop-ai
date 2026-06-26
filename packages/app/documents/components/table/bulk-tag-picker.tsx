"use client";

import { TagEntityType } from "@repo/api/src/types/tag";
import { TagChip } from "@repo/app/tags/components/tag-chip";
import { useBatchApplyTag, useTags } from "@repo/app/tags/hooks/use-tags";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { toast } from "@repo/design-system/components/ui/sonner";
import { TagIcon } from "lucide-react";
import { useState } from "react";

type BulkTagPickerProps = {
  selectedIds: Set<string>;
  onComplete: () => void;
};

export function BulkTagPicker({ selectedIds, onComplete }: BulkTagPickerProps) {
  const [open, setOpen] = useState(false);
  const { data: tags } = useTags();
  const batchApplyTag = useBatchApplyTag();

  function handleTagSelect(tagId: string, tagName: string) {
    const entityIds = [...selectedIds];
    batchApplyTag.mutate(
      {
        tagId,
        entityType: TagEntityType.Artifact,
        entityIds,
      },
      {
        onSuccess: (result) => {
          toast.success(
            `Applied "${tagName}" to ${result.appliedCount} ${result.appliedCount === 1 ? "item" : "items"}`
          );
          setOpen(false);
          onComplete();
        },
      }
    );
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="h-8 text-xs"
          disabled={batchApplyTag.isPending}
          size="sm"
          variant="outline"
        >
          <TagIcon className="h-4 w-4" />
          Add Tag
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-56 p-2">
        {tags && tags.length > 0 ? (
          <div className="flex flex-col gap-1">
            {tags.map((tag) => (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                key={tag.id}
                onClick={() => handleTagSelect(tag.id, tag.name)}
                type="button"
              >
                <TagChip tag={tag} />
              </button>
            ))}
          </div>
        ) : (
          <p className="py-2 text-center text-muted-foreground text-sm">
            No tags available
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
