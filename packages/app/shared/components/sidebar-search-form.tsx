"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { SearchIcon, XIcon } from "lucide-react";
import type { ComponentPropsWithoutRef, FormEvent } from "react";

export type SidebarSearchFormProps = {
  /** Controlled search text displayed in the sidebar input. */
  value: string;
  /** Adapter-owned native form target for pre-hydration or no-JS submits. */
  nativeAction?: string;
  /** Adapter-owned native form method for pre-hydration or no-JS submits. */
  nativeMethod?: ComponentPropsWithoutRef<"form">["method"];
  /** Adapter-owned native query field name for pre-hydration or no-JS submits. */
  nativeInputName?: string;
  /** Placeholder shown when the controlled value is empty. */
  placeholder?: string;
  /** Whether the clear affordance should be rendered. */
  showClear: boolean;
  /** Called with the latest input text after the form submit is prevented. */
  onSubmit: (value: string) => void;
  /** Called whenever the controlled input changes. */
  onValueChange: (value: string) => void;
  /** Called when the visible clear affordance is activated. */
  onClear: () => void;
};

/**
 * Shared sidebar search chrome for web and desktop adapters.
 * Route, query-param, and domain behavior stay in the adapter callbacks.
 */
export function SidebarSearchForm({
  value,
  nativeAction,
  nativeMethod,
  nativeInputName,
  placeholder = "Search",
  showClear,
  onSubmit,
  onValueChange,
  onClear,
}: SidebarSearchFormProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(value);
  };

  return (
    <form
      action={nativeAction}
      className="flex items-center px-2 pt-2.5"
      method={nativeMethod}
      onSubmit={handleSubmit}
    >
      <div className="relative w-full">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          size={14}
        />
        <Input
          aria-label="Search"
          className="h-8 rounded-full border-input-border bg-transparent py-1.5 pr-8 pl-8 text-xs shadow-none focus-visible:bg-background"
          name={nativeInputName}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
          type="text"
          value={value}
        />
        {showClear && (
          <button
            aria-label="Clear search"
            className="absolute top-1/2 right-2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={onClear}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        )}
      </div>
    </form>
  );
}
