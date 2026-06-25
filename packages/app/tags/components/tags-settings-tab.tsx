"use client";

import type { Tag, TagColor } from "@repo/api/src/types/tag";
import { TAG_COLORS } from "@repo/api/src/types/tag";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
import type { Column } from "@repo/design-system/components/ui/data-table";
import { DataTable } from "@repo/design-system/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import { toast } from "@repo/design-system/components/ui/sonner";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { ConfirmationDialog } from "../../shared/components/confirmation-dialog";
import {
  useCreateTag,
  useDeleteTag,
  useTags,
  useUpdateTag,
} from "../hooks/use-tags";
import { TagChip } from "./tag-chip";
import { TagColorPicker } from "./tag-color-picker";

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

  const columns: Column<Tag>[] = [
    {
      key: "color",
      header: "",
      render: (tag) => (
        <TagColorPicker
          onChange={(c) => handleRecolor(tag, c)}
          value={tag.color as TagColor}
        />
      ),
    },
    {
      key: "name",
      header: "Name",
      render: (tag) => (
        <InlineNameEditor
          onSave={(n) => handleRename(tag, n)}
          value={tag.name}
        />
      ),
    },
    {
      key: "preview",
      header: "Preview",
      render: (tag) => (
        <TagChip
          size="md"
          tag={{ id: tag.id, name: tag.name, color: tag.color as TagColor }}
        />
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      render: (tag) => (
        <span className="text-muted-foreground text-sm">
          {formatRelativeTime(tag.createdAt)}
        </span>
      ),
    },
  ];

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
            maxLength={40}
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost">
                <MoreHorizontalIcon className="h-4 w-4" />
                <span className="sr-only">Open actions menu</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setDeleteTarget(tag)}
              >
                Delete tag
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

function InlineNameEditor({
  value,
  onSave,
}: Readonly<{
  value: string;
  onSave: (name: string) => void;
}>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        className="rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        type="button"
      >
        {value}
      </button>
    );
  }

  return (
    <Input
      aria-label="Rename tag"
      autoFocus
      className="h-7 max-w-[200px] text-sm"
      maxLength={40}
      onBlur={() => {
        onSave(draft);
        setEditing(false);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onSave(draft);
          setEditing(false);
        }
        if (e.key === "Escape") {
          setEditing(false);
        }
      }}
      value={draft}
    />
  );
}
