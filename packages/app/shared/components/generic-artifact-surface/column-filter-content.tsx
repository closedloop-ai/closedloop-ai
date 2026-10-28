"use client";

import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { GenericArtifactKind } from "./generic-artifact-status";
import { genericArtifactFacetForKey } from "./generic-artifact-status";

export function ColumnFilterContent({
  columnId,
  onToggle,
  options,
  representedKinds,
  selectedValues,
}: {
  columnId: string;
  onToggle: (value: string) => void;
  options: readonly string[];
  representedKinds: readonly GenericArtifactKind[];
  selectedValues: readonly string[];
}) {
  return (
    <>
      <DropdownMenuLabel className="text-muted-foreground">
        Filter {columnId}
      </DropdownMenuLabel>
      {options.map((option) => {
        const facet =
          columnId === "status"
            ? genericArtifactFacetForKey(representedKinds, option)
            : null;
        return (
          <DropdownMenuCheckboxItem
            checked={selectedValues.includes(option)}
            key={option}
            onCheckedChange={() => onToggle(option)}
            onSelect={(event) => event.preventDefault()}
          >
            {facet ? (
              <span
                className={
                  facet.normalized.detail ? "ml-3 border-l pl-3" : undefined
                }
              >
                <ArtifactStatus
                  facet={facet}
                  variant={ArtifactStatusVariant.FilterOption}
                />
              </span>
            ) : (
              option
            )}
          </DropdownMenuCheckboxItem>
        );
      })}
    </>
  );
}
