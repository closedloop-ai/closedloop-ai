import { Fragment, type ReactNode } from "react";

/**
 * Two-column "state name → rendered state" grid used by the cell showcases.
 * A cell's states are only legible side by side — an em-dash that means "no
 * parent" and an em-dash that means "not editable" are the same glyph until
 * something names them — so the label column is the story, not decoration.
 */
export function LabelledStates({
  rows,
}: Readonly<{ rows: ReadonlyArray<readonly [string, ReactNode]> }>) {
  return (
    <div className="grid grid-cols-[9rem_auto] items-center gap-x-6 gap-y-2 text-muted-foreground text-sm">
      {rows.map(([label, state]) => (
        <Fragment key={label}>
          <span>{label}</span>
          <div className="flex border-y">{state}</div>
        </Fragment>
      ))}
    </div>
  );
}
