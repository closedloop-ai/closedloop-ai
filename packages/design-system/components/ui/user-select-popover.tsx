"use client";

import * as React from "react";
import { UserPlusIcon } from "lucide-react";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@closedloop-ai/design-system/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@closedloop-ai/design-system/components/ui/command";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@closedloop-ai/design-system/components/ui/avatar";

export interface User {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  initials?: string;
}

interface UserSelectPopoverProps {
  /** Currently selected user */
  value?: User | null;
  /** Callback when user is selected */
  onSelect: (user: User | null) => void;
  /** List of users to choose from */
  users: User[];
  /** Placeholder text when no user is selected */
  placeholder?: string;
  /** Whether to show the trigger as just an icon (for inline use) */
  iconOnly?: boolean;
  /** Trigger element (optional, defaults to add-person icon button) */
  trigger?: React.ReactNode;
  /** Disable the popover */
  disabled?: boolean;
  /** Additional class name for trigger */
  className?: string;
  /** Trigger element id, so a sibling `<Label htmlFor>` can point at it. */
  id?: string;
  /**
   * Accessible field label for the default trigger. When set, the trigger
   * announces e.g. "Assignee: Ada Lovelace" instead of just the value, so a
   * screen reader knows which field the control sets. The colon form matches
   * the sibling Status/Priority pills in the metadata bar.
   */
  ariaLabel?: string;
  /**
   * The user list is still loading. Swaps the empty-state copy so the picker
   * reads "Loading…" instead of falsely claiming there are no users while the
   * fetch is in flight.
   */
  isLoading?: boolean;
}

/**
 * Get initials from a name
 */
function getInitials(name: string): string {
  return name
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * UserSelectPopover provides a searchable dropdown for selecting a user
 * Can be used inline in tables with icon-only mode
 */
function UserSelectPopover({
  value,
  onSelect,
  users,
  placeholder = "Select user...",
  iconOnly = false,
  trigger,
  disabled = false,
  className,
  id,
  ariaLabel,
  isLoading = false,
}: UserSelectPopoverProps) {
  const [open, setOpen] = React.useState(false);

  // Field-labeled accessible name so a screen reader announces which field the
  // control sets (e.g. "Assignee: Ada Lovelace") rather than the value alone.
  // The colon form matches the sibling Status/Priority metadata-bar pills.
  const currentValueLabel = value?.name ?? placeholder;
  const triggerAriaLabel = ariaLabel
    ? `${ariaLabel}: ${currentValueLabel}`
    : undefined;

  const handleSelect = (user: User) => {
    onSelect(user);
    setOpen(false);
  };

  const handleClear = () => {
    onSelect(null);
    setOpen(false);
  };

  const defaultTrigger = iconOnly ? (
    <Button
      aria-label={triggerAriaLabel}
      variant="ghost"
      size="icon"
      id={id}
      className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", className)}
      disabled={disabled}
    >
      <UserPlusIcon className="h-4 w-4" />
      <span className="sr-only">{placeholder}</span>
    </Button>
  ) : (
    <Button
      aria-label={triggerAriaLabel}
      variant="outline"
      role="combobox"
      aria-expanded={open}
      id={id}
      className={cn("w-[200px] justify-start", className)}
      disabled={disabled}
    >
      {value ? (
        <div className="flex items-center gap-2">
          <Avatar className="h-5 w-5">
            {value.avatarUrl && <AvatarImage src={value.avatarUrl} alt={value.name} />}
            <AvatarFallback className="text-[10px]">
              {value.initials || getInitials(value.name)}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{value.name}</span>
        </div>
      ) : (
        <span className="text-muted-foreground">{placeholder}</span>
      )}
    </Button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger || defaultTrigger}</PopoverTrigger>
      <PopoverContent className="w-[250px] p-0" align="start">
        <Command label="Search users">
          <CommandInput placeholder="Search users..." />
          <CommandList>
            <CommandEmpty>
              {isLoading ? "Loading…" : "No users found."}
            </CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem
                  onSelect={handleClear}
                  className="cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Clear selection
                </CommandItem>
              )}
              {users.map((user) => (
                <CommandItem
                  key={user.id}
                  value={`${user.name} ${user.email || ""}`}
                  onSelect={() => handleSelect(user)}
                  className="cursor-pointer hover:bg-muted"
                >
                  <Avatar className="mr-2 h-6 w-6">
                    {user.avatarUrl && (
                      <AvatarImage src={user.avatarUrl} alt={user.name} />
                    )}
                    <AvatarFallback className="text-[10px]">
                      {user.initials || getInitials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col">
                    <span>{user.name}</span>
                    {user.email && (
                      <span className="text-xs text-muted-foreground">
                        {user.email}
                      </span>
                    )}
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

export { UserSelectPopover, getInitials };
export type { UserSelectPopoverProps };
