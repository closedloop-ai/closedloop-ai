"use client";

// DS-GAP: local stand-in for the same proposed <PropertiesPanel> primitive
// used by the Branches and Sessions prototypes. Keep this implementation in
// lockstep with those reference surfaces until the pattern is promoted.

import { cn } from "@repo/design-system/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

export type PropertyRow = {
  label: string;
  value: ReactNode;
};

export function PropertiesPanel({
  rows,
  preview,
  defaultOpen = false,
}: {
  rows: PropertyRow[];
  preview: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section>
      <button
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 py-1 font-semibold text-foreground text-sm"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        Properties
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,18.75rem),1fr))] gap-x-10 gap-y-0.5 rounded-lg bg-muted p-4">
          {rows.map((row) => (
            <div
              className="grid min-h-7 grid-cols-[7rem_minmax(0,1fr)] items-start gap-3"
              key={row.label}
            >
              <dt className="font-semibold text-muted-foreground text-sm">
                {row.label}
              </dt>
              <dd className="inline-flex w-fit min-w-0 max-w-full items-start gap-2 text-sm">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <button
          className="mt-3 flex w-full flex-wrap items-center gap-x-[1.125rem] gap-y-2 rounded-lg bg-muted p-4 text-left"
          onClick={() => setOpen(true)}
          type="button"
        >
          {preview}
        </button>
      )}
    </section>
  );
}
