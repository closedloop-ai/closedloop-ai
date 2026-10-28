"use client";

import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import {
  artifactStatusFullLabel,
  artifactStatusLabel,
} from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { groupArtifactStatusTargets } from "@repo/app/shared/lib/artifact-status-targets";
import type { ArtifactStatusFacet } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { CircleDotDashedIcon } from "lucide-react";
import { useState } from "react";
import {
  genericArtifactStatusCapability,
  genericArtifactStatusFacet,
  genericArtifactStatusFromRaw,
  genericArtifactStatusLabel,
} from "../../generic-artifact-status";
import type {
  ArtifactKind,
  ArtifactStatus as PreviewStatus,
} from "../fixtures";

/** Creation has no artifact ID, so it reuses the champion's status facets and target grouping without inventing an editor commit. */
export function ArtifactCreationStatusPicker({
  kind,
  onChange,
  status,
}: Readonly<{
  kind: ArtifactKind;
  onChange: (status: PreviewStatus) => void;
  status: PreviewStatus;
}>) {
  const [open, setOpen] = useState(false);
  const source = { kind, status };
  const capability = genericArtifactStatusCapability(source);
  const label = genericArtifactStatusLabel(source);
  const vocabulary = genericArtifactStatusFacet(source).vocabulary;
  const groups = capability.editable
    ? groupArtifactStatusTargets(capability.allowedTargets, vocabulary)
    : [];

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Change status…"
          className="h-8 max-w-56 rounded-full px-3 font-normal"
          disabled={!capability.editable}
          type="button"
          variant="outline"
        >
          <CircleDotDashedIcon />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Change status…" />
          <CommandList>
            <CommandEmpty>No options found.</CommandEmpty>
            {groups.map((group) => {
              const rootLabel = ARTIFACT_STATUS_DISPLAY_LABELS[group.root];
              const rootFacet: ArtifactStatusFacet = {
                normalized: { root: group.root },
                raw: null,
                vocabulary,
              };
              return (
                <CommandGroup aria-label={rootLabel} key={group.root}>
                  {group.parents.length > 0 ? (
                    group.parents.map(({ target }) => (
                      <CommandItem
                        aria-label={rootLabel}
                        key={target}
                        onSelect={() => selectRaw(target)}
                        value={rootLabel}
                      >
                        <ArtifactStatus
                          facet={rootFacet}
                          variant={ArtifactStatusVariant.BulkOption}
                        />
                      </CommandItem>
                    ))
                  ) : (
                    <div className="flex items-center px-2 py-1.5 text-sm">
                      <ArtifactStatus
                        facet={rootFacet}
                        variant={ArtifactStatusVariant.BulkOption}
                      />
                    </div>
                  )}
                  {group.children.map(({ normalized, target }) => {
                    const facet: ArtifactStatusFacet = {
                      normalized,
                      raw: target,
                      vocabulary: rootFacet.vocabulary,
                    };
                    return (
                      <CommandItem
                        aria-label={artifactStatusFullLabel(facet)}
                        className="ml-3 border-l pl-3"
                        key={target}
                        onSelect={() => selectRaw(target)}
                        value={`${rootLabel} ${artifactStatusLabel(facet)}`}
                      >
                        {artifactStatusLabel(facet)}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );

  function selectRaw(raw: string) {
    const next = genericArtifactStatusFromRaw(kind, raw);
    if (next !== null) {
      onChange(next);
      setOpen(false);
    }
  }
}
