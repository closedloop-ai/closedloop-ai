"use client";

import type { Tag, TagColor } from "@repo/api/src/types/tag";
import { TAG_COLORS, TAG_NAME_MAX_LENGTH } from "@repo/api/src/types/tag";
import { TagColorPicker } from "@repo/app/shared/components/tag-color-picker";
import { Button } from "@repo/design-system/components/ui/button";
import { DataTable } from "@repo/design-system/components/ui/data-table";
import { Input } from "@repo/design-system/components/ui/input";
import { toast } from "@repo/design-system/components/ui/sonner";
import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { ConfirmationDialog } from "../../shared/components/confirmation-dialog";
import {
  useCreateTag,
  useDeleteTag,
  useTags,
  useUpdateTag,
} from "../hooks/use-tags";
import { buildTagColumns, TagRowActions } from "./tag-columns";

export function TagsSettingsTab() {
  const { data: tags = [] } = useTags();
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();
  const deleteTag = useDeleteTag();
  const [deleteTarget, setDeleteTarget] = useState<Tag | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState<TagColor>(TAG_COLORS[0]);

  const handleCreate = useCallback(() => {
    const name = newTagName.trim();
    if (!name) {
      return;
    }
    createTag.mutate(
      { name, color: newTagColor },
      {
        onSuccess: () => {
          setNewTagName("");
          setNewTagColor(TAG_COLORS[(tags.length + 1) % TAG_COLORS.length]);
          setIsCreating(false);
        },
      }
    );
  }, [createTag, newTagName, newTagColor, tags.length]);

  const handleRename = useCallback(
    (tag: Tag, name: string) => {
      if (name.trim() && name.trim() !== tag.name) {
        updateTag.mutate({ id: tag.id, name: name.trim() });
      }
    },
    [updateTag]
  );

  const handleRecolor = useCallback(
    (tag: Tag, color: TagColor) => {
      if (color !== tag.color) {
        updateTag.mutate({ id: tag.id, color });
      }
    },
    [updateTag]
  );

  const handleDelete = useCallback(() => {
    if (!deleteTarget) {
      return;
    }
    deleteTag.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success(`Tag "${deleteTarget.name}" deleted`);
        setDeleteTarget(null);
      },
    });
  }, [deleteTag, deleteTarget]);

  const columns = buildTagColumns({
    onRecolor: handleRecolor,
    onRename: handleRename,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-lg">Tags</h3>
          <p className="text-muted-foreground text-sm">
            Manage org-wide tags that can be applied to any artifact.
          </p>
        </div>
        <Button
          disabled={isCreating}
          onClick={() => {
            setNewTagColor(TAG_COLORS[tags.length % TAG_COLORS.length]);
            setIsCreating(true);
          }}
          size="sm"
        >
          <PlusIcon className="mr-1 h-4 w-4" />
          Create tag
        </Button>
      </div>

      {isCreating ? (
        <div className="flex items-center gap-2 rounded-lg border p-3">
          <TagColorPicker onChange={setNewTagColor} value={newTagColor} />
          <Input
            aria-label="New tag name"
            autoFocus
            className="h-8 max-w-xs"
            maxLength={TAG_NAME_MAX_LENGTH}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleCreate();
              }
              if (e.key === "Escape") {
                setIsCreating(false);
              }
            }}
            placeholder="Tag name"
            value={newTagName}
          />
          <Button
            disabled={!newTagName.trim() || createTag.isPending}
            onClick={handleCreate}
            size="sm"
          >
            Create
          </Button>
          <Button
            onClick={() => setIsCreating(false)}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        data={tags}
        renderRowActions={(tag) => (
          <TagRowActions onDelete={setDeleteTarget} tag={tag} />
        )}
        searchKey="name"
      />

      <ConfirmationDialog
        confirmLabel="Delete"
        description={`This will remove the tag "${deleteTarget?.name}" from all artifacts it's applied to. This action cannot be undone.`}
        onConfirm={handleDelete}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        open={deleteTarget !== null}
        title="Delete tag"
        variant="destructive"
      />
    </div>
  );
}
