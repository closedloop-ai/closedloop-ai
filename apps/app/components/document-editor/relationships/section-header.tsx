"use client";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

type SectionHeaderProps = {
  title: string;
  children?: ReactNode;
  /**
   * When provided alongside `onToggle`, the title + chevron act as a single
   * click target that toggles the section's open state. `children` (e.g. an
   * add/"+" action button) remain aligned to the far right of the header.
   */
  isOpen?: boolean;
  onToggle?: () => void;
};

export function SectionHeader({
  title,
  children,
  isOpen,
  onToggle,
}: Readonly<SectionHeaderProps>) {
  const showToggle = onToggle !== undefined && isOpen !== undefined;

  return (
    <div className="flex h-12 items-center gap-2 border-b py-2">
      {showToggle ? (
        <button
          aria-expanded={isOpen}
          className="flex shrink-0 items-center gap-2"
          onClick={onToggle}
          type="button"
        >
          <span className="font-semibold text-lg">{title}</span>
          {isOpen ? (
            <ChevronDownIcon className="h-4 w-4" />
          ) : (
            <ChevronRightIcon className="h-4 w-4" />
          )}
        </button>
      ) : (
        <span className="shrink-0 font-semibold text-lg">{title}</span>
      )}
      <div className="min-w-0 flex-1" />
      {children == null ? null : (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      )}
    </div>
  );
}
