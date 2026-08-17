// The per-field conversion breakdown: what carries over cleanly, what converts
// with changes, and what is dropped. Plain rows grouped under one heading, not a
// grid of boxes, so the eye reads straight down the list. The source field, the
// arrow, the target field (or "Dropped"), and the support glyph sit on one row;
// any caveat sits beneath in muted text.

import { ArrowRightIcon } from "lucide-react";
import { type FieldMapping, FieldSupport } from "../mock";
import { FieldSupportBadge } from "./convert-meta";

// Only the exceptions earn a badge. A supported row reads "source → target" in
// plain type; a column of identical "Converts cleanly" chips is noise under a
// banner that already said everything maps.
const badgedSupport = (support: FieldSupport): boolean =>
  support !== FieldSupport.Supported;

const TargetField = ({ mapping }: { mapping: FieldMapping }) => {
  if (mapping.targetField === null) {
    // Dropped: say so in words. Repeating the source name (even struck
    // through) reads as "Subagent delegation → Subagent delegation" to a
    // screen reader, which conveys nothing about the field being gone.
    return (
      <span className="text-muted-foreground text-sm italic">Dropped</span>
    );
  }
  return <span className="text-foreground text-sm">{mapping.targetField}</span>;
};

const FieldRow = ({ mapping }: { mapping: FieldMapping }) => (
  <li className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-foreground text-sm">{mapping.sourceField}</span>
        <ArrowRightIcon
          aria-label="maps to"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <TargetField mapping={mapping} />
      </div>
      {badgedSupport(mapping.support) ? (
        <FieldSupportBadge support={mapping.support} />
      ) : null}
    </div>
    {mapping.note ? (
      <p className="text-muted-foreground text-sm leading-relaxed">
        {mapping.note}
      </p>
    ) : null}
  </li>
);

export const FieldBreakdown = ({
  mappings,
}: {
  mappings: readonly FieldMapping[];
}) => {
  // Carried fields first, dropped last, so the list ends on the losses.
  const order: Record<FieldSupport, number> = {
    [FieldSupport.Supported]: 0,
    [FieldSupport.Partial]: 1,
    [FieldSupport.Unsupported]: 2,
  };
  const sorted = [...mappings].sort(
    (a, b) => order[a.support] - order[b.support]
  );
  return (
    <ul className="divide-y divide-border">
      {sorted.map((mapping) => (
        <FieldRow key={mapping.sourceField} mapping={mapping} />
      ))}
    </ul>
  );
};
