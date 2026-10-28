"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useState } from "react";
import type {
  AutoExcludedDirectory,
  DirectoryScopeEntry,
  DirectoryScopeListCopy,
} from "./directory-scope-list";
import {
  type AddDirectoryControlCopy,
  DirectoryScopeListWithAdd,
  type PickedDirectory,
} from "./directory-scope-list-with-add";

/**
 * The mock host for {@link DirectoryScopeListWithAdd}, owned here because
 * `scripts/lint/production-bound-prototype-route.ts` allows a production-bound
 * route no markup beyond its `main` landmark. The pick switcher stands in for
 * the native folder picker; each option is labelled by its fictional path, and
 * its legend is a prop, so this module originates no words.
 */
export type DirectoryScopeListWithAddDemoProps = {
  readonly listCopy: DirectoryScopeListCopy;
  readonly addCopy: AddDirectoryControlCopy;
  readonly initialEntries: readonly DirectoryScopeEntry[];
  readonly initialIncludedIds: readonly string[];
  readonly defaultExpandedIds: readonly string[];
  readonly autoExcluded: readonly AutoExcludedDirectory[];
  readonly picks: readonly PickedDirectory[];
  readonly pickLegend: string;
  readonly onPickError: (error: unknown) => void;
};

export const DirectoryScopeListWithAddDemo = ({
  listCopy,
  addCopy,
  initialEntries,
  initialIncludedIds,
  defaultExpandedIds,
  autoExcluded,
  picks,
  pickLegend,
  onPickError,
}: DirectoryScopeListWithAddDemoProps) => {
  const [entries, setEntries] = useState(initialEntries);
  const [includedIds, setIncludedIds] = useState(initialIncludedIds);
  const [nextPickId, setNextPickId] = useState(picks[0]?.id ?? "");
  const nextPick = picks.find((pick) => pick.id === nextPickId) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-6 py-10">
      <fieldset className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
        <legend className="sr-only">{pickLegend}</legend>
        {picks.map((pick) => (
          <Button
            aria-pressed={pick.id === nextPickId}
            key={pick.id}
            onClick={() => setNextPickId(pick.id)}
            size="sm"
            type="button"
            variant={pick.id === nextPickId ? "default" : "outline"}
          >
            {pick.label}
          </Button>
        ))}
      </fieldset>
      <DirectoryScopeListWithAdd
        add={{
          copy: addCopy,
          onAdd: (entry) => setEntries((previous) => [...previous, entry]),
          onPickError,
          pickDirectory: () => Promise.resolve(nextPick),
        }}
        autoExcluded={autoExcluded}
        copy={listCopy}
        defaultExpandedIds={defaultExpandedIds}
        entries={entries}
        includedIds={includedIds}
        onIncludedIdsChange={setIncludedIds}
      />
    </div>
  );
};
