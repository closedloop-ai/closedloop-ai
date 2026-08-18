"use client";

// DS-GAP: local stand-in for a proposed <PropertiesPanel> primitive.
// Not in @repo/design-system yet. The catalog "MetadataPanel" is a right-hand
// sidebar container (w-80, border-l), NOT this pattern: a collapsible
// "Properties" disclosure whose open body is a muted card with a two-column
// auto-fit label/value grid. The pattern currently lives only as raw
// `.sd3-props` / `.prd-props` CSS in packages/app/styles.css, shared by the
// session-detail and branch-detail surfaces. Before productionizing, promote it
// via a separate DS PR (component + story + catalog:sync), then swap this local
// stand-in for the real import. See the "Component gaps" section of the PR.

import { cn } from "@repo/design-system/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

export type PropertyRow = {
  label: string;
  value: ReactNode;
};

export function PropertiesPanel({
  rows,
  collapsedSummary,
  title = "Properties",
  defaultOpen = false,
}: {
  rows: PropertyRow[];
  collapsedSummary: ReactNode;
  title?: string;
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
        {title}
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 transition-transform", open && "rotate-90")}
        />
      </button>

      {open ? (
        <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,18.75rem),1fr))] gap-x-10 gap-y-0.5 rounded-lg bg-muted p-4">
          {rows.map((row) => (
            <div
              className="grid min-h-7 grid-cols-[7rem_minmax(0,1fr)] items-center gap-3"
              key={row.label}
            >
              <dt className="font-semibold text-[0.8125rem] text-muted-foreground">
                {row.label}
              </dt>
              <dd className="inline-flex w-fit min-w-0 max-w-full items-center gap-2 text-sm">
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
          {collapsedSummary}
        </button>
      )}
    </section>
  );
}
