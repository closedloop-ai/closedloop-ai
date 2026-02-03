"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { cn } from "@repo/design-system/lib/utils";
import type { LucideIcon } from "lucide-react";

export type ToolbarAction = {
  /**
   * Unique identifier for the action
   */
  id: string;
  /**
   * Label text for the button
   */
  label: string;
  /**
   * Optional icon component (from lucide-react)
   */
  icon?: LucideIcon;
  /**
   * Click handler for the action
   */
  onClick: () => void;
  /**
   * Whether the action is disabled
   */
  disabled?: boolean;
  /**
   * Button variant
   */
  variant?: "default" | "outline" | "ghost" | "destructive";
};

export type ToolbarDropdownItem = {
  /**
   * Unique identifier for the item
   */
  id: string;
  /**
   * Label text for the menu item
   */
  label: string;
  /**
   * Optional icon component (from lucide-react)
   */
  icon?: LucideIcon;
  /**
   * Click handler for the item
   */
  onClick: () => void;
  /**
   * Whether the item is disabled
   */
  disabled?: boolean;
  /**
   * Whether to show a separator before this item
   */
  separator?: boolean;
  /**
   * Item variant (default or destructive)
   */
  variant?: "default" | "destructive";
};

export type ToolbarDropdown = {
  /**
   * Unique identifier for the dropdown
   */
  id: string;
  /**
   * Label text for the trigger button
   */
  label: string;
  /**
   * Optional icon component for the trigger button
   */
  icon?: LucideIcon;
  /**
   * Menu items
   */
  items: ToolbarDropdownItem[];
  /**
   * Whether the dropdown is disabled
   */
  disabled?: boolean;
  /**
   * Button variant for the trigger
   */
  variant?: "default" | "outline" | "ghost";
};

type EditorToolbarProps = {
  /**
   * Action buttons to display
   */
  actions?: ToolbarAction[];
  /**
   * Dropdown menus to display
   */
  dropdowns?: ToolbarDropdown[];
  /**
   * Optional className for custom styling
   */
  className?: string;
};

export function EditorToolbar({
  actions = [],
  dropdowns = [],
  className,
}: Readonly<EditorToolbarProps>) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-background p-2",
        className
      )}
    >
      {/* Render action buttons */}
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <Button
            disabled={action.disabled}
            key={action.id}
            onClick={action.onClick}
            size="sm"
            variant={action.variant || "ghost"}
          >
            {Icon && <Icon className="h-4 w-4" />}
            {action.label}
          </Button>
        );
      })}

      {/* Render separator between actions and dropdowns if both exist */}
      {actions.length > 0 && dropdowns.length > 0 && (
        <div className="mx-1 h-6 w-px bg-border" />
      )}

      {/* Render dropdown menus */}
      {dropdowns.map((dropdown) => {
        const TriggerIcon = dropdown.icon;
        return (
          <DropdownMenu key={dropdown.id}>
            <DropdownMenuTrigger asChild>
              <Button
                disabled={dropdown.disabled}
                size="sm"
                variant={dropdown.variant || "ghost"}
              >
                {TriggerIcon && <TriggerIcon className="h-4 w-4" />}
                {dropdown.label}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {dropdown.items.map((item, index) => {
                const ItemIcon = item.icon;
                const showSeparator = item.separator && index > 0;
                return (
                  <div key={item.id}>
                    {showSeparator && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      disabled={item.disabled}
                      onClick={item.onClick}
                      variant={item.variant ?? "default"}
                    >
                      {ItemIcon && <ItemIcon className="mr-2 h-4 w-4" />}
                      {item.label}
                    </DropdownMenuItem>
                  </div>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </div>
  );
}
