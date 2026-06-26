"use client";

import type { TagEntityType, TagSummary } from "@repo/api/src/types/tag";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { Separator } from "@repo/design-system/components/ui/separator";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, Loader2Icon, PlusIcon, TagIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  useApplyTag,
  useCreateTag,
  useRemoveTag,
  useTags,
} from "../hooks/use-tags";
import { TagChip } from "./tag-chip";

type TagPickerProps = {
  entityType: TagEntityType;
  entityId: string;
  appliedTags: TagSummary[];
  /** Custom trigger element. When provided, replaces the default button. */
  trigger?: ReactNode;
  /** Whether to show the create-tag option. Defaults to true. */
  showCreate?: boolean;
  /** Called when an applied tag chip is clicked. */
  onChipClick?: (tag: TagSummary) => void;
};

export function TagPicker({
  entityType,
  entityId,
  appliedTags,
  trigger,
  showCreate = true,
  onChipClick,
}: Readonly<TagPickerProps>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Defer the org-wide tag fetch until the picker is opened: the inline
  // appliedTags come from props, so nothing renders this list until the
  // popover is shown (CLAUDE.md: avoid reflexive on-mount fetching).
  const { data: allTags = [], isLoading } = useTags({ enabled: open });
  const applyTag = useApplyTag();
  const removeTag = useRemoveTag();
  const createTag = useCreateTag();

  const appliedIds = useMemo(
    () => new Set(appliedTags.map((t) => t.id)),
    [appliedTags]
  );

  const filtered = useMemo(() => {
    if (!search.trim()) {
      return allTags;
    }
    const lower = search.toLowerCase();
    return allTags.filter((t) => t.name.toLowerCase().includes(lower));
  }, [allTags, search]);

  const applied = useMemo(
    () => filtered.filter((t) => appliedIds.has(t.id)),
    [filtered, appliedIds]
  );

  const available = useMemo(
    () => filtered.filter((t) => !appliedIds.has(t.id)),
    [filtered, appliedIds]
  );

  const showCreateOption =
    showCreate &&
    search.trim().length > 0 &&
    !allTags.some((t) => t.name.toLowerCase() === search.trim().toLowerCase());

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearch("");
    }
  }, []);

  const handleApply = useCallback(
    (tagId: string) => {
      applyTag.mutate({ tagId, entityType, entityId });
      setSearch("");
    },
    [applyTag.mutate, entityType, entityId]
  );

  const handleRemove = useCallback(
    (tagId: string) => {
      removeTag.mutate({ tagId, entityType, entityId });
    },
    [removeTag.mutate, entityType, entityId]
  );

  const handleCreate = useCallback(() => {
    const name = search.trim();
    if (!name) {
      return;
    }
    createTag.mutate(
      { name },
      {
        onSuccess: (result) => {
          setSearch("");
          applyTag.mutate({ tagId: result.id, entityType, entityId });
        },
      }
    );
  }, [createTag.mutate, applyTag.mutate, search, entityType, entityId]);

  const chips = appliedTags.map((tag) => (
    <TagChip
      key={tag.id}
      onClick={onChipClick ? () => onChipClick(tag) : undefined}
      onRemove={() => handleRemove(tag.id)}
      tag={tag}
    />
  ));

  const defaultTriggerButton = (
    <Button className="h-5 gap-1 px-1.5 text-[11px]" size="sm" variant="ghost">
      {appliedTags.length === 0 ? (
        <>
          <TagIcon className="h-3 w-3" />
          Add tag
        </>
      ) : (
        <PlusIcon className="h-3 w-3" />
      )}
    </Button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips}
      <Popover onOpenChange={handleOpenChange} open={open}>
        <PopoverTrigger asChild>
          {trigger ?? defaultTriggerButton}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-56 p-0"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="p-2">
            <Input
              aria-label="Search tags"
              autoFocus
              className="h-8 text-sm"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") {
                  return;
                }
                const trimmed = search.trim();
                if (!trimmed) {
                  return;
                }
                const exactMatch = allTags.find(
                  (t) =>
                    t.name.toLowerCase() === trimmed.toLowerCase() &&
                    !appliedIds.has(t.id)
                );
                if (exactMatch) {
                  handleApply(exactMatch.id);
                } else if (showCreateOption) {
                  handleCreate();
                }
              }}
              placeholder="Search tags..."
              value={search}
            />
          </div>
          <div className="max-h-[240px] overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {applied.length > 0 ? (
                  <div className="px-1 pb-1">
                    <p className="px-2 py-1 text-[11px] text-muted-foreground">
                      Applied
                    </p>
                    {applied.map((tag) => (
                      <TagPickerItem
                        applied
                        key={tag.id}
                        onClick={() => handleRemove(tag.id)}
                        tag={tag}
                      />
                    ))}
                  </div>
                ) : null}
                {applied.length > 0 && available.length > 0 ? (
                  <Separator />
                ) : null}
                {available.length > 0 ? (
                  <div className="px-1 py-1">
                    {applied.length > 0 ? (
                      <p className="px-2 py-1 text-[11px] text-muted-foreground">
                        All tags
                      </p>
                    ) : null}
                    {available.map((tag) => (
                      <TagPickerItem
                        key={tag.id}
                        onClick={() => handleApply(tag.id)}
                        tag={tag}
                      />
                    ))}
                  </div>
                ) : null}
                {showCreateOption ? (
                  <>
                    <Separator />
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={handleCreate}
                      type="button"
                    >
                      <PlusIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="flex-1">
                        Create &ldquo;{search.trim()}&rdquo;
                      </span>
                      <kbd className="rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                        Enter
                      </kbd>
                    </button>
                  </>
                ) : null}
                {filtered.length === 0 && !showCreateOption ? (
                  <p className="px-3 py-4 text-center text-muted-foreground text-sm">
                    No tags found
                  </p>
                ) : null}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TagPickerItem({
  tag,
  applied,
  onClick,
}: Readonly<{
  tag: TagSummary;
  applied?: boolean;
  onClick: () => void;
}>) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted",
        applied && "text-muted-foreground"
      )}
      onClick={onClick}
      type="button"
    >
      <TagChip size="sm" tag={tag} />
      {applied ? <CheckIcon className="ml-auto h-3.5 w-3.5" /> : null}
    </button>
  );
}
