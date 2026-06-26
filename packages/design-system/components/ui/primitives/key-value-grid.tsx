"use client";

import { memo, useMemo } from "react";
import type { JsonValue } from "../types";

type KeyValueGridProps = {
  data: Record<string, JsonValue>;
  priority?: string[];
};

function renderValue(value: JsonValue) {
  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>;
  }

  if (typeof value === "boolean") {
    return (
      <span className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[11px]">
        {value ? "true" : "false"}
      </span>
    );
  }

  if (typeof value === "number") {
    return <span className="font-mono">{value.toLocaleString()}</span>;
  }

  if (typeof value === "string") {
    return <span className="break-all font-mono text-foreground">{value}</span>;
  }

  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// Memoized row so renderValue (which runs JSON.stringify for object-typed
// cells) only re-runs when that row's key/value actually changes, rather than
// on every KeyValueGrid render.
const KeyValueRow = memo(function KeyValueRow({
  rowKey,
  value,
  withBorder,
}: {
  rowKey: string;
  value: JsonValue;
  withBorder: boolean;
}) {
  return (
    <tr className={withBorder ? "border-border/70 border-t" : undefined}>
      <td className="w-[28%] bg-muted/45 px-3 py-2 align-top font-mono text-muted-foreground">
        {rowKey}
      </td>
      <td className="px-3 py-2 align-top">{renderValue(value)}</td>
    </tr>
  );
});

export function KeyValueGrid({
  data,
  priority = [],
}: KeyValueGridProps) {
  const rows = useMemo(() => {
    const priorityEntries = priority
      .map((key) => [key, data[key]] as const)
      .filter((entry) => entry[1] !== undefined);
    const restEntries = Object.entries(data).filter(
      ([key]) => !priority.includes(key)
    );
    return [...priorityEntries, ...restEntries];
  }, [data, priority]);

  if (rows.length === 0) {
    return <p className="text-[11px] text-muted-foreground italic">Empty</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/70">
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          {rows.map(([key, value], index) => (
            <KeyValueRow
              key={key}
              rowKey={key}
              value={value}
              withBorder={index > 0}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
