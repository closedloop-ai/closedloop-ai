"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type {
  TagColor,
  TagEntityType,
  TagSummary,
} from "@repo/api/src/types/tag";
import { TAG_CREATE_COLOR_FLAG_KEY } from "@repo/api/src/types/tag-create-color-flag";
import { ColorSwatchGrid } from "@repo/app/shared/components/color-swatch-picker";
import { TagChip } from "@repo/app/shared/components/tag-chip";
import {
  pickTagColorLabel,
  TAG_COLOR_PALETTE,
} from "@repo/app/shared/components/tag-color-picker";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { Separator } from "@repo/design-system/components/ui/separator";
import { cn } from "@repo/design-system/lib/utils";
import type { QueryClient } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, PlusIcon, TagIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useApplyTag,
  useCreateTag,
  useRemoveTag,
  useTags,
  useUpdateTag,
} from "../hooks/use-tags";

type TagPickerProps = {
  entityType: TagEntityType;
  entityId: string;
  appliedTags: TagSummary[];
  /** Custom trigger element. When provided, replaces the default button. */
  trigger?: ReactNode;
  /** Whether to show the create-tag option. Defaults to true. */
  showCreate?: boolean;
  /** Permit applying existing or newly created tags. Defaults to true. */
  canApply?: boolean;
  /** Permit removing applied tags. Defaults to true. */
  canRemove?: boolean;
  /** Render applied chips beside the trigger. Defaults to true. */
  showAppliedChips?: boolean;
  /**
   * ISS-12452: the client the caller's OWN reads of this entity are cached
   * in, when it differs from the ambient one — Branches on desktop injects
   * its own (`useBranchesQueryContext`). Omitted, the apply/remove/update
   * mutations invalidate the ambient client, which is correct for every
   * surface that does not inject one.
   */
  queryClient?: QueryClient;
  surface?: ArtifactStatusEditSurface;
};

export function TagPicker({
  entityType,
  entityId,
  appliedTags,
  trigger,
  showCreate = true,
  canApply = true,
  canRemove = true,
  showAppliedChips = true,
  queryClient,
  surface,
}: Readonly<TagPickerProps>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // ISS-6385, default off: the tag just created, held so the picker can offer
  // its colour instead of closing on a colour the user never chose.
  const [pendingColorTag, setPendingColorTag] = useState<TagSummary | null>(
    null
  );
  // The colour asked for and not yet confirmed by the PATCH. Held separately
  // from `pendingColorTag.color` (the server-assigned one) so the step can show
  // the choice while it is in flight and re-offer it when the write fails.
  const [attemptedColor, setAttemptedColor] = useState<TagColor | null>(null);
  // `open` as the create mutation's callback will see it. State is stale in
  // that closure, and the popover can close while the POST is in flight.
  const openRef = useRef(false);
  const createColorEnabled = useFeatureFlagEnabledOptional(
    TAG_CREATE_COLOR_FLAG_KEY
  );

  // packages/app/AGENTS.md: transient state is scoped to the stable entity
  // identity. A mounted picker handed a different row must not keep offering
  // the previous row's create flow — a swatch clicked there PATCHes the tag
  // that row created, not anything the new row names. Reset DURING RENDER
  // rather than in an effect: React re-runs this component before committing,
  // so the stale step is never painted, and the identity is a trigger rather
  // than something the reset reads (which `useExhaustiveDependencies` would
  // strip from an effect's dependency list, leaving it firing on mount only).
  const entityKey = `${entityType}:${entityId}`;
  const [renderedEntityKey, setRenderedEntityKey] = useState(entityKey);
  if (renderedEntityKey !== entityKey) {
    setRenderedEntityKey(entityKey);
    setSearch("");
    setPendingColorTag(null);
    setAttemptedColor(null);
  }

  // Defer the org-wide tag fetch until the picker is opened: the inline
  // appliedTags come from props, so nothing renders this list until the
  // popover is shown (AGENTS.md: avoid reflexive on-mount fetching).
  const { data: allTags = [], isLoading } = useTags({ enabled: open });
  const applyTag = useApplyTag({ queryClient });
  const removeTag = useRemoveTag({ queryClient });
  const createTag = useCreateTag();
  const updateTag = useUpdateTag({ queryClient });

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
    () => (canApply ? filtered.filter((t) => !appliedIds.has(t.id)) : []),
    [filtered, appliedIds, canApply]
  );

  const showCreateOption =
    canApply &&
    showCreate &&
    search.trim().length > 0 &&
    !allTags.some((t) => t.name.toLowerCase() === search.trim().toLowerCase());

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    openRef.current = nextOpen;
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearch("");
      setPendingColorTag(null);
      setAttemptedColor(null);
    }
  }, []);

  const handleApply = useCallback(
    (tagId: string) => {
      applyTag.mutate({ tagId, entityType, entityId, surface });
      setSearch("");
    },
    [applyTag.mutate, entityType, entityId, surface]
  );

  const handleRemove = useCallback(
    (tagId: string) => {
      removeTag.mutate({ tagId, entityType, entityId, surface });
    },
    [removeTag.mutate, entityType, entityId, surface]
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
          applyTag.mutate({
            tagId: result.id,
            entityType,
            entityId,
            surface,
          });
          // Only offer the colour step if the popover is STILL open. Closing it
          // mid-flight already cleared `pendingColorTag`; putting it back here
          // would hand the user a colour step for a tag created long ago the
          // next time they open the picker.
          if (createColorEnabled && openRef.current) {
            setPendingColorTag(result);
          }
        },
      }
    );
  }, [
    createTag.mutate,
    applyTag.mutate,
    search,
    entityType,
    entityId,
    createColorEnabled,
    surface,
  ]);

  const handlePickColor = useCallback(
    (color: TagColor) => {
      if (!pendingColorTag) {
        return;
      }
      setAttemptedColor(color);
      // The step closes on the WRITE, not on the click. Closing optimistically
      // left a failed PATCH looking like a saved colour, and took the only
      // in-place retry with it.
      updateTag.mutate(
        { color, id: pendingColorTag.id },
        {
          onSuccess: () => {
            setPendingColorTag(null);
            setAttemptedColor(null);
          },
        }
      );
    },
    [updateTag.mutate, pendingColorTag]
  );

  const chips = appliedTags.map((tag) => (
    <TagChip
      key={tag.id}
      onRemove={canRemove ? () => handleRemove(tag.id) : undefined}
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
      {showAppliedChips ? chips : null}
      <Popover onOpenChange={handleOpenChange} open={open}>
        <PopoverTrigger asChild>
          {trigger ?? defaultTriggerButton}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-56 p-0"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {pendingColorTag ? (
            <TagCreatedColorStep
              attemptedColor={attemptedColor}
              onPick={handlePickColor}
              tag={pendingColorTag}
              // `isError` outlives the step that produced it — it survives
              // until the next `mutate`. Pairing it with an unconfirmed
              // attempt keeps a failure from the LAST tag off the next tag's
              // step, which resets `attemptedColor` and has asked for nothing.
              writeFailed={updateTag.isError && attemptedColor !== null}
            />
          ) : (
            <>
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
              <TagPickerList
                applied={applied}
                available={available}
                canRemove={canRemove}
                isLoading={isLoading}
                onApply={handleApply}
                onCreate={handleCreate}
                onRemove={handleRemove}
                search={search}
                showCreateOption={showCreateOption}
                showNoResults={filtered.length === 0 && !showCreateOption}
              />
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * ISS-6385: the step that turns "create a tag" into "create a tag AND colour
 * it". Shown only while {@link TAG_CREATE_COLOR_FLAG_KEY} is on, and only for
 * the tag this picker just created — the tag is already created and applied by
 * the time it renders, so dismissing the popover keeps the tag and its
 * server-assigned colour, and picking simply changes that colour.
 *
 * The grid is the shared {@link ColorSwatchGrid} over the canonical
 * `TAG_COLOR_PALETTE`, not a local swatch set, and each swatch is named by its
 * colour so the choice never rests on hue alone (WCAG 1.4.1).
 *
 * The step OUTLIVES the click: it closes when the PATCH succeeds, and on
 * failure it stays put holding the colour that was asked for, so the grid is
 * itself the retry. Closing on the click showed the user a saved colour the
 * server never took.
 */
function TagCreatedColorStep({
  tag,
  onPick,
  attemptedColor,
  writeFailed,
}: Readonly<{
  tag: TagSummary;
  onPick: (color: TagColor) => void;
  /** The colour asked for and not yet written, or `null` when none is. */
  attemptedColor: TagColor | null;
  writeFailed: boolean;
}>) {
  // The search input this step replaces unmounts mid-interaction, and Radix
  // manages focus only on popover open/close — so without this the keyboard
  // user who just pressed Enter is left with nothing focused.
  const headingRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="p-3">
      <p
        className="mb-2 text-muted-foreground text-xs outline-none"
        ref={headingRef}
        tabIndex={-1}
      >
        {pickTagColorLabel(tag.name)}
      </p>
      <ColorSwatchGrid
        columns={8}
        onSelect={onPick}
        palette={TAG_COLOR_PALETTE}
        selectedName={attemptedColor ?? tag.color}
      />
      {writeFailed ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          That color didn&rsquo;t save. Pick one to try again.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The picker's scrollable body: loading, the applied and available groups, the
 * create row, and the no-results line. Extracted from {@link TagPicker} so the
 * component that owns the mutations is not also the one branching seven ways
 * over what to draw.
 */
function TagPickerList({
  applied,
  available,
  canRemove,
  isLoading,
  onApply,
  onCreate,
  onRemove,
  search,
  showCreateOption,
  showNoResults,
}: Readonly<{
  applied: TagSummary[];
  available: TagSummary[];
  canRemove: boolean;
  isLoading: boolean;
  onApply: (tagId: string) => void;
  onCreate: () => void;
  onRemove: (tagId: string) => void;
  search: string;
  showCreateOption: boolean;
  showNoResults: boolean;
}>) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <div className="max-h-[240px] overflow-y-auto">
      {applied.length > 0 ? (
        <div className="px-1 pb-1">
          <p className="px-2 py-1 text-[11px] text-muted-foreground">Applied</p>
          {applied.map((tag) => (
            <TagPickerItem
              applied
              key={tag.id}
              onClick={canRemove ? () => onRemove(tag.id) : undefined}
              tag={tag}
            />
          ))}
        </div>
      ) : null}
      {applied.length > 0 && available.length > 0 ? <Separator /> : null}
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
              onClick={() => onApply(tag.id)}
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
            onClick={onCreate}
            type="button"
          >
            <PlusIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1">Create &ldquo;{search.trim()}&rdquo;</span>
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
              Enter
            </kbd>
          </button>
        </>
      ) : null}
      {showNoResults ? (
        <p className="px-3 py-4 text-center text-muted-foreground text-sm">
          No tags found
        </p>
      ) : null}
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
  onClick?: () => void;
}>) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted",
        applied && "text-muted-foreground"
      )}
      disabled={!onClick}
      onClick={onClick}
      type="button"
    >
      <TagChip size="sm" tag={tag} />
      {applied ? <CheckIcon className="ml-auto h-3.5 w-3.5" /> : null}
    </button>
  );
}
