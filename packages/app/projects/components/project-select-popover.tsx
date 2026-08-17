"use client";

import { Button } from "@repo/design-system/components/ui/button";
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
import { useState } from "react";

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
}: ProjectSelectPopoverProps) {
  const [open, setOpen] = useState(false);

  const currentValueLabel = value?.name ?? placeholder;
  const triggerAriaLabel = ariaLabel
    ? `${ariaLabel}: ${currentValueLabel}`
    : undefined;

  const handleSelect = (project: ProjectOption) => {
    onSelect(project);
    setOpen(false);
  };

  const handleClear = () => {
    onSelect(null);
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-label={triggerAriaLabel}
          className={cn("w-full justify-start", className)}
          disabled={disabled}
          id={id}
          role="combobox"
          variant="outline"
        >
          <FolderIcon aria-hidden className="shrink-0" />
          {value ? (
            <span className="truncate">{value.name}</span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command label="Search projects">
          <CommandInput placeholder="Search projects…" />
          <CommandList>
            <CommandEmpty>{emptyStateMessage(isLoading, isError)}</CommandEmpty>
            <CommandGroup>
              {value ? (
                <CommandItem
                  className="cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground"
                  onSelect={handleClear}
                >
                  Clear selection
                </CommandItem>
              ) : null}
              {projects.map((project) => (
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
