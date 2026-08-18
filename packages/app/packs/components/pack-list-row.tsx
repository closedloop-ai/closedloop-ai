"use client";

import type { ReactNode } from "react";

// A plain divided list row for a marketplace/available pack: name + publisher,
// a one-line description, and a trailing action. A list of these sits inside a
// single bordered container (one border, not one card per pack) so the
// secondary regions read as a calm list, not a card mosaic.
type PackListRowProps = {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly description: string;
  readonly action: ReactNode;
};

export const PackListRow = ({
  name,
  version,
  publisher,
  description,
  action,
}: PackListRowProps) => (
  <div className="flex items-center gap-4 px-4 py-3">
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className="truncate font-medium text-sm">{name}</span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {version}
        </span>
      </div>
      <p className="truncate text-muted-foreground text-xs">
        {publisher} · {description}
      </p>
    </div>
    <div className="shrink-0">{action}</div>
  </div>
);
