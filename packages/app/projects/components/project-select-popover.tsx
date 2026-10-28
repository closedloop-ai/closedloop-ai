"use client";

import {
  compareListQueryText,
  ListQueryTextOrdering,
} from "@repo/api/src/types/list-query-ordering-semantics";
import {
  Button,
  type ButtonProps,
} from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";
import { FolderIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

/**
 * A ClosedLoop project as the typeahead needs it — the display name plus the
 * stable id and the (optional) human slug. The consumer resolves the value the
 * create/file call wants (slug when present, else id).
 */
export type ProjectOption = {
  id: string;
  name: string;
  slug?: string | null;
};

export type ProjectSelectPopoverProps = {
  /** The currently-selected project, or null when nothing is chosen. */
  value?: ProjectOption | null;
  /** Fires with the picked project, or null when the selection is cleared. */
  onSelect: (project: ProjectOption | null) => void;
  /**
   * Offer "Clear selection" once a project is chosen. The Session and Branch
   * Project rows pass false: `batch-move` accepts a clear since ISS-12858, but
   * offering one on those rows is not yet decided (ISS-12859 owns the Details
   * row).
   */
  allowClear?: boolean;
  /**
   * Fires when the popover opens or closes, so a consumer can defer loading
   * `projects` until the list is actually asked for (`@repo/app` AGENTS.md:
   * menu data is gated, not fetched on mount). The trigger renders from
   * `value` alone, so nothing above needs the list to paint.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * The trigger's button treatment. `outline` is the boxed form a dialog field
   * wants; `ghost` is the hover-only form an inline table or Details row wants
   * (ISS-12252: editability is hover and cursor, never a border or a badge).
   */
  variant?: ButtonProps["variant"];
  /** The projects to choose from (already loaded by the parent). */
  projects: readonly ProjectOption[];
  /** Trigger placeholder when nothing is selected. */
  placeholder?: string;
  /** Disable the whole control. */
  disabled?: boolean;
  /** Extra classes for the trigger. */
  className?: string;
  /** Trigger element id, so a sibling `<Label htmlFor>` can point at it. */
  id?: string;
  /**
   * Accessible field label for the trigger. When set the trigger announces
   * e.g. "Project: Platform" so a screen reader knows which field it sets.
   */
  ariaLabel?: string;
  /**
   * The project list is still loading. Distinguishes "fetching" from "genuinely
   * empty" so the picker never claims the org has no projects mid-flight.
   */
  isLoading?: boolean;
  /**
   * The project list failed to load. Surfaces an honest error instead of a
   * false empty state that would present a failed fetch as "no projects".
   */
  isError?: boolean;
  /**
   * What the trigger shows when nothing is selected, instead of the muted
   * {@link placeholder}.
   *
   * An inline table cell passes the shared empty sentinel, because a column of
   * facts must keep stating the fact: "Select project…" repeated down every
   * unfiled row turns the column into a list of instructions, and the sibling
   * editable cells already resolve this the same way (`EntityTagsCell`'s
   * `emptyValue`, `ArtifactPriorityEditor`'s dash inside the button). A dialog
   * field keeps the placeholder, where an instruction is what the reader wants.
   */
  emptyMark?: ReactNode;
  /**
   * Whether the trigger leads with the folder glyph. A boxed form field wants
   * it; an inline cell does not — its read-only twin is bare text, so the glyph
   * would make one field look like two depending on write access, and it
   * restates a column already headed "Owning project" on every row.
   */
  leadingIcon?: boolean;
};

/**
 * A searchable project typeahead (FEA-4008). A domain component — it renders the
 * ClosedLoop "project" concept — composing the generic `Command`/`Popover`
 * primitives, so it lives in `@repo/app` and is shared by web + desktop. Mirrors
 * the sibling `UserSelectPopover` pattern for a consistent picker feel.
 */
export function ProjectSelectPopover({
  value,
  onSelect,
  projects,
  placeholder = "Select project…",
  disabled = false,
  className,
  id,
  ariaLabel,
  isLoading = false,
  isError = false,
  emptyMark,
  leadingIcon = true,
  allowClear = true,
  variant = "outline",
  onOpenChange,
}: ProjectSelectPopoverProps) {
  const [open, setOpen] = useState(false);
  const sortedProjects = useMemo(
    () => [...projects].sort(compareProjectsByName),
    [projects]
  );

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const currentValueLabel = value?.name ?? placeholder;
  const triggerAriaLabel = ariaLabel
    ? `${ariaLabel}: ${currentValueLabel}`
    : undefined;

  const handleSelect = (project: ProjectOption) => {
    onSelect(project);
    handleOpenChange(false);
  };

  const handleClear = () => {
    onSelect(null);
    handleOpenChange(false);
  };

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-label={triggerAriaLabel}
          className={cn("w-full justify-start", className)}
          disabled={disabled}
          id={id}
          role="combobox"
          variant={variant}
        >
          {leadingIcon ? <FolderIcon aria-hidden className="shrink-0" /> : null}
          {value ? (
            // `min-w-0` is what lets `truncate` fire at all: a flex child
            // defaults to `min-width:auto`, so without it the span sizes to its
            // text and a long project name leaves the trigger's box instead of
            // ellipsising inside it.
            <span className="min-w-0 truncate">{value.name}</span>
          ) : (
            (emptyMark ?? (
              <span className="text-muted-foreground">{placeholder}</span>
            ))
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
        // marisolashgrove, ISS-12454: a `CommandItem` is `div role=option`, which
        // `INTERACTIVE_CELL_CONTENT_SELECTOR` does not list, and React bubbles
        // the pick out of the portal up to the grid row's `onClick` — so filing
        // one row replaced a six-row bulk selection with that row. This marker
        // is that selector's own opt-out. Unconditional rather than per
        // presentation: a project option is never a row-selection target in any
        // host, and a flag to say so is a flag that can be wired wrong.
        data-no-row-select
      >
        <Command label="Search projects">
          <CommandInput placeholder="Search projects…" />
          <CommandList>
            <CommandEmpty>{emptyStateMessage(isLoading, isError)}</CommandEmpty>
            <CommandGroup>
              {value && allowClear ? (
                <CommandItem
                  className="cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground"
                  onSelect={handleClear}
                >
                  Clear selection
                </CommandItem>
              ) : null}
              {sortedProjects.map((project) => (
                <CommandItem
                  className="cursor-pointer hover:bg-muted"
                  key={project.id}
                  onSelect={() => handleSelect(project)}
                  value={`${project.name} ${project.slug ?? ""}`}
                >
                  <div className="flex flex-col">
                    <span>{project.name}</span>
                    {project.slug ? (
                      <span className="text-muted-foreground text-xs">
                        {project.slug}
                      </span>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The value the create/file call wants for a project: its slug when present
 * (human-readable, stable), else its id. The platform create contract accepts
 * either a uuid or a slug for `projectId`/`projectSlug`.
 */
export function projectSelectionValue(project: ProjectOption): string {
  return project.slug && project.slug.length > 0 ? project.slug : project.id;
}

/**
 * The empty-state copy for the typeahead — honest about *why* the list is
 * empty. A still-loading or failed fetch must never read as "no projects
 * found", which would present in-flight or error state as a genuinely empty
 * org (and disable creation on a false premise).
 */
function emptyStateMessage(isLoading: boolean, isError: boolean): string {
  if (isLoading) {
    return "Loading projects…";
  }
  if (isError) {
    return "Couldn't load projects. Check your connection and try again.";
  }
  return "No projects found.";
}

function compareProjectsByName(a: ProjectOption, b: ProjectOption): number {
  return (
    compareListQueryText(a.name, b.name, ListQueryTextOrdering.Collated) ||
    compareListQueryText(a.id, b.id, ListQueryTextOrdering.CodeUnit)
  );
}
