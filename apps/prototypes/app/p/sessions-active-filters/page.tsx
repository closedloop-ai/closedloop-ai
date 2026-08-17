"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { FilterChip } from "@repo/design-system/components/ui/filter-chip";
import { FilterIcon, ListFilterIcon } from "lucide-react";
import { useState } from "react";
import {
  type ActiveChip,
  deriveChips,
  EMPTY_FILTERS,
  type FacetFilters,
  INITIAL_FILTERS,
  type MockSessionRow,
  mockSessionRows,
} from "./mock";

/**
 * Presentational prototype for the Sessions active-filter chip row (ISS-4605).
 *
 * Mock-data only: a stand-in Sessions toolbar (a "Filter" popover trigger + a
 * View menu, presentational) with the new chip row beneath it, ABOVE a stand-in
 * session table whose Cost column carries the honest missing-cost "—" state.
 * That pairing is the whole story: with a Cost = Unknown facet active, the chip
 * row NAMES what is filtering the list, so the column of dashes reads as a
 * filtered cohort instead of a broken column. Each chip removes just its value;
 * "Clear all" resets every facet.
 *
 * Note (design divergence, deliberate for this pass): like the production
 * `SessionsActiveFiltersBar`, these chips are remove-only — no click-to-edit
 * dropdown body and no in-row "+" add-filter control (adding a filter is the
 * Filter popover's job). Documents' catalog `ActiveFiltersBar` behaves
 * differently; reconciling the two is out of scope for this prototype.
 */
const SessionsActiveFiltersPrototype = () => {
  const [filters, setFilters] = useState<FacetFilters>(INITIAL_FILTERS);
  const chips = deriveChips(filters, setFilters);
  const rows = mockSessionRows(filters);

  return (
    <div className="mx-auto flex min-h-svh max-w-4xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-lg">Sessions</h1>
        <p className="text-muted-foreground text-sm">
          Active-filter chip row - one removable chip per active facet, plus
          clear-all.
        </p>
      </header>

      {/* The real toolbar isn't a bordered box — it's a pinned cluster above the
          scroll region — so this stays unboxed to keep the spacing read honest. */}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button className="gap-1.5" size="sm" type="button" variant="outline">
            <FilterIcon className="size-4" />
            Filter
            {/* Once the chip row is visible the chips ARE the count — and they
                name what's on — so the numeric badge is redundant and drops. */}
            {chips.length === 0 ? null : (
              <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-primary-foreground text-xs">
                {chips.length}
              </span>
            )}
          </Button>
          <Button className="gap-1.5" size="sm" type="button" variant="outline">
            <ListFilterIcon className="size-4" />
            View
          </Button>
        </div>

        <ActiveFiltersRow
          chips={chips}
          onClearAll={() => setFilters(EMPTY_FILTERS)}
        />
      </section>

      <MockSessionsTable rows={rows} />

      <SandboxCohortSwitcher onApply={setFilters} />
    </div>
  );
};

const ActiveFiltersRow = ({
  chips,
  onClearAll,
}: {
  chips: ActiveChip[];
  onClearAll: () => void;
}) => {
  // Render nothing when no facet is active — exactly what the production bar
  // does. (The empty-state explanation lives in the prototype meta, not as
  // product copy on the canvas.)
  if (chips.length === 0) {
    return null;
  }

  return (
    // Cap the height and scroll internally so a busy selection (seven-plus
    // chips) can't wrap to several rows and shove the table down — matching the
    // production bar's pinned-toolbar constraint.
    <div className="flex max-h-16 flex-wrap items-center gap-1.5 overflow-y-auto">
      {chips.map((chip) => (
        <FilterChip
          key={chip.key}
          label={`${chip.facetLabel}: ${chip.valueLabel}`}
          onRemove={chip.remove}
        />
      ))}
      <Button
        className="h-auto px-2 py-1 text-xs"
        onClick={onClearAll}
        type="button"
        variant="ghost"
      >
        Clear all
      </Button>
    </div>
  );
};

const MockSessionsTable = ({ rows }: { rows: MockSessionRow[] }) => (
  <div className="overflow-hidden rounded-md border">
    <table className="w-full text-sm">
      <thead className="bg-muted/40 text-left text-muted-foreground">
        <tr>
          <th className="px-3 py-2 font-medium">Session</th>
          <th className="px-3 py-2 font-medium">Owner</th>
          <th className="px-3 py-2 font-medium">Repository</th>
          <th className="px-3 py-2 font-medium">Status</th>
          <th className="px-3 py-2 text-right font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className="border-t" key={row.id}>
            <td className="px-3 py-2">{row.name}</td>
            <td className="px-3 py-2 text-muted-foreground">{row.owner}</td>
            <td className="px-3 py-2 text-muted-foreground">
              {row.repository}
            </td>
            <td className="px-3 py-2 text-muted-foreground">{row.status}</td>
            <td className="px-3 py-2 text-right tabular-nums">
              {formatCost(row.costUsd)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const COHORTS: { label: string; filters: FacetFilters }[] = [
  {
    label: "Cost = Unknown",
    filters: { ...EMPTY_FILTERS, costBuckets: ["unknown"] },
  },
  {
    label: "Failed, one owner",
    filters: { ...EMPTY_FILTERS, statuses: ["error"], userIds: ["user-ada"] },
  },
  {
    // The busy case: seven active chips, so the row's wrap/scroll gets stressed
    // the way the real nine-facet surface can (stage review).
    label: "Many facets (7 chips)",
    filters: {
      ...EMPTY_FILTERS,
      statuses: ["inactive"],
      userIds: ["user-ada"],
      autonomyTiers: ["high"],
      harnesses: ["claude"],
      models: ["claude-opus-4"],
      changePresence: ["has_changes"],
      repositories: ["closedloop-ai/symphony-alpha"],
    },
  },
];

// Sandbox chrome — NOT part of the surface. This is a reviewer control to flip
// the mock cohort so the chip row + Cost column can be judged in each state; it
// wouldn't ship, so it's visually separated from the prototype above.
const SandboxCohortSwitcher = ({
  onApply,
}: {
  onApply: (next: FacetFilters) => void;
}) => (
  <section className="mt-2 flex flex-col gap-2 border-t border-dashed pt-4">
    <p className="text-muted-foreground text-xs uppercase tracking-wide">
      Sandbox controls — flip the mock cohort
    </p>
    <div className="flex flex-wrap gap-2">
      {COHORTS.map((cohort) => (
        <Button
          key={cohort.label}
          onClick={() => onApply(cohort.filters)}
          size="sm"
          type="button"
          variant="secondary"
        >
          {cohort.label}
        </Button>
      ))}
    </div>
  </section>
);

function formatCost(costUsd: number | null): string {
  // The honest missing-cost state — the same "—" the chip row names as
  // "Cost: Unknown", so the column and the chip say the same thing.
  if (costUsd === null) {
    return "—";
  }
  return `$${costUsd.toFixed(2)}`;
}

export default SessionsActiveFiltersPrototype;
