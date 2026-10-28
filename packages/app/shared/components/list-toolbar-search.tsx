"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { useEffect, useRef, useState } from "react";
import {
  LIST_TOOLBAR_SEARCH_LABEL,
  LIST_TOOLBAR_SEARCH_PLACEHOLDER,
} from "./list-toolbar-copy";

/** The contract a page hands a toolbar to opt into the shared search. */
export type ListToolbarSearchControl = {
  onChange: (value: string) => void;
  value: string;
};

/**
 * PRD-721: the one free-text search every list toolbar renders. The words are
 * the ones the Documents list shipped; a list never restates them.
 *
 * The typed text is held locally and re-synced from `value` only when it moves
 * to a different term, because a host that stores the trimmed term would
 * otherwise swallow the space typed between two words.
 */
export function ListToolbarSearch({
  onChange,
  value,
}: ListToolbarSearchControl) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    // While the reader is typing, a host whose value trails the input (the URL
    // writes back a moment later) would reset the draft to an older echo and
    // drop keystrokes; an external change is adopted once the input is left.
    if (focused.current) {
      return;
    }
    setDraft((current) => (current.trim() === value.trim() ? current : value));
  }, [value]);
  return (
    <Input
      aria-label={LIST_TOOLBAR_SEARCH_LABEL}
      className="h-8 max-w-64"
      onBlur={() => {
        focused.current = false;
        setDraft((current) =>
          current.trim() === value.trim() ? current : value
        );
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
      onFocus={() => {
        focused.current = true;
      }}
      placeholder={LIST_TOOLBAR_SEARCH_PLACEHOLDER}
      value={draft}
    />
  );
}
