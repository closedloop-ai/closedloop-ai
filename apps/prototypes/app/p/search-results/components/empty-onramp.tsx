"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { ArrowUpRightIcon, SearchIcon } from "lucide-react";
import { type ExampleQuery, exampleQueries } from "../mock";

// The empty state (no query yet). Rather than redirect away, the search page
// lands a designed on-ramp: the DS EmptyState header (its rounded-square media,
// title, and description — no hand-rolled full circle) plus a short grammar hint
// and a few example queries the user can run in one click, hung underneath. This
// gives the query bar somewhere to start from.
export function EmptyOnRamp({
  onRunExample,
}: Readonly<{ onRunExample: (query: string) => void }>) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-6">
      <EmptyState
        description="Type words to search, or compose a filter query — combine type:, status:, and an @owner mention to narrow the results."
        icon={SearchIcon}
        title="Search everything"
      />
      <ul className="flex w-full flex-col gap-2 text-left">
        {exampleQueries.map((example) => (
          <ExampleRow
            example={example}
            key={example.query}
            onRun={onRunExample}
          />
        ))}
      </ul>
    </div>
  );
}

function ExampleRow({
  example,
  onRun,
}: Readonly<{ example: ExampleQuery; onRun: (query: string) => void }>) {
  return (
    <li>
      <button
        className="group flex w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-left hover:border-primary/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={() => onRun(example.query)}
        type="button"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-foreground text-sm">
            {example.query}
          </span>
          <span className="truncate text-muted-foreground text-xs">
            {example.caption}
          </span>
        </span>
        <ArrowUpRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
        />
      </button>
    </li>
  );
}
