"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { ArrowUpRightIcon, SearchIcon } from "lucide-react";

/** One example query the empty-state on-ramp offers (a JQL cheat-sheet). */
export type SearchExampleQuery = { query: string; caption: string };

/**
 * The example queries the empty on-ramp runs in one click. HONEST per FEA-4134
 * OQ decisions: values use the real wire kinds the parser accepts (`type:
 * agent_session`, not the prototype's `type:session`), and no `@me` — the parser
 * resolves an owner mention against a real email/GitHub handle/name, so `@me`
 * would be a dead suggestion. Each example composes only supported grammar
 * (`type:`, `status:`, `priority` comparison), so running it always parses.
 */
export const SEARCH_EXAMPLE_QUERIES: readonly SearchExampleQuery[] = [
  {
    query: "agent type:agent_session status:DONE",
    caption: "Finished agent sessions",
  },
  {
    query: "type:branch type:document",
    caption: "Branches and docs, one query",
  },
  { query: "priority>=HIGH status:BLOCKED", caption: "Urgent and stuck" },
];

/**
 * FEA-4134 — the `/search` empty state (no query yet). Rather than redirect
 * away, the search page lands a designed on-ramp: the DS {@link EmptyState}
 * header plus a short grammar hint and a few example queries the user can run in
 * one click. Faithful to the FEA-4031 prototype. The hint copy names ONLY the
 * grammar the parser supports (FEA-4134 OQ#4).
 */
export function SearchEmptyOnRamp({
  onRunExample,
}: Readonly<{ onRunExample: (query: string) => void }>) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-6">
      <EmptyState
        description="Type words to search, or compose a filter query — combine type:, status:, priority, project:, and an @owner mention to narrow the results."
        icon={SearchIcon}
        title="Search everything"
      />
      <ul className="flex w-full flex-col gap-2 text-left">
        {SEARCH_EXAMPLE_QUERIES.map((example) => (
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
}: Readonly<{
  example: SearchExampleQuery;
  onRun: (query: string) => void;
}>) {
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
