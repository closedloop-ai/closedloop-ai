"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { cn } from "@repo/design-system/lib/utils";
import { CornerDownLeftIcon, SearchIcon, XIcon } from "lucide-react";
import type {
  ComponentPropsWithoutRef,
  FormEvent,
  KeyboardEvent,
  RefObject,
} from "react";

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
  /**
   * Adapter-owned keydown handler on the input, so a consumer with an attached
   * listbox (e.g. the search typeahead) can drive combobox keyboard navigation
   * (Arrow keys / Enter / Escape) without moving focus off the native field.
   */
  onInputKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /**
   * Adapter-owned ref to the native input, so a typeahead consumer can read the
   * caret offset (for caret-aware intellisense) and restore focus + selection
   * after committing a suggestion. Omitted by plain consumers.
   */
  inputRef?: RefObject<HTMLInputElement | null>;
  /**
   * Adapter-owned handler fired when the input's selection/caret changes
   * (`onSelect`), so a caret-aware typeahead can track where the user is typing.
   */
  onInputSelect?: () => void;
  /**
   * ARIA combobox wiring for an attached popup listbox. When the consumer
   * renders a listbox dropdown it passes these so the input announces the
   * expanded state and the active option to assistive tech. Omitted by plain
   * (non-typeahead) consumers, which stay a bare text input.
   */
  comboboxProps?: {
    "aria-controls"?: string;
    "aria-expanded"?: boolean;
    "aria-activedescendant"?: string;
  };
};

const DEFAULT_PLACEHOLDER = "Search";

/**
 * Shared sidebar search chrome for web and desktop adapters.
 * Route, query-param, and domain behavior stay in the adapter callbacks.
 */
export function SidebarSearchForm({
  value,
  nativeAction,
  nativeMethod,
  nativeInputName,
  placeholder = DEFAULT_PLACEHOLDER,
  showClear,
  onSubmit,
  onValueChange,
  onClear,
  onInputKeyDown,
  inputRef,
  onInputSelect,
  comboboxProps,
}: SidebarSearchFormProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(value);
  };

  // The box is submit-on-Enter with no live results, so an idle field reads as
  // inert (FEA-3980). Surface a return-key hint the moment there is a query to
  // submit, and keep it up alongside the clear affordance (both adapters flip
  // `showClear` true as soon as any text is typed, so the hint has to coexist
  // with the clear button rather than yield the slot to it — otherwise it would
  // never render on web or desktop). The hint is decorative; the input's own
  // instructions carry the same guidance to assistive tech.
  const showEnterHint = value.trim().length > 0;

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
          aria-activedescendant={comboboxProps?.["aria-activedescendant"]}
          aria-controls={comboboxProps?.["aria-controls"]}
          aria-describedby={ENTER_HINT_DESCRIPTION_ID}
          aria-expanded={comboboxProps?.["aria-expanded"]}
          aria-label="Search"
          {...(comboboxProps
            ? { "aria-autocomplete": "list" as const, role: "combobox" }
            : {})}
          // Touch pointers floor the field to the 44px WCAG 2.5.5 target
          // (`--tap-min`); the dense `h-8` height is unchanged on mouse. The
          // trailing padding widens to reserve room for the "Enter" hint (and
          // more when the clear button sits beside it) so typed text never runs
          // under either affordance.
          className={cn(
            "h-8 touch:h-tap-min rounded-full border-input-border bg-transparent py-1.5 pr-8 pl-8 text-xs shadow-none focus-visible:bg-background",
            showEnterHint && !showClear && "pr-16",
            showEnterHint && showClear && "pr-24"
          )}
          name={nativeInputName}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          onSelect={onInputSelect}
          placeholder={placeholder}
          ref={inputRef}
          type="text"
          value={value}
        />
        <span className="sr-only" id={ENTER_HINT_DESCRIPTION_ID}>
          Press Enter to search
        </span>
        {showEnterHint && (
          // Decorative return-key affordance; the sr-only description above
          // conveys the same instruction to assistive tech, so this stays out
          // of the a11y tree. It sits left of the clear button when both show.
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1/2 inline-flex -translate-y-1/2 items-center gap-1 text-[10px] text-muted-foreground",
              showClear ? "right-8" : "right-2.5"
            )}
          >
            <CornerDownLeftIcon size={12} />
            <kbd className="font-sans">Enter</kbd>
          </span>
        )}
        {showClear && (
          <button
            aria-label="Clear search"
            // The visible glyph stays compact inside the pill; on touch the
            // `after` overlay expands the tap zone to the 44px WCAG 2.5.5
            // target without enlarging the icon or overflowing the input.
            className="absolute top-1/2 right-2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors after:absolute after:-inset-3 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 md:after:hidden"
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

const ENTER_HINT_DESCRIPTION_ID = "sidebar-search-enter-hint";
