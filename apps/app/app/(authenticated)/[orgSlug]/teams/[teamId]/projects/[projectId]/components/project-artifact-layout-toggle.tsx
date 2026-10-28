"use client";

import { useManualArtifactOrderingEnabled } from "@repo/app/shared/feature-flags/use-manual-artifact-ordering";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { LayoutGridIcon, ListIcon } from "lucide-react";

/** Closed-flag layout switch for the All Artifacts project tab. */
export function ProjectArtifactLayoutToggle({
  activeTab,
  layout,
  onChange,
}: Readonly<{
  activeTab: string;
  layout: "board" | "list";
  onChange: (layout: string) => void;
}>) {
  const enabled = useManualArtifactOrderingEnabled();
  if (!(enabled && activeTab === "all")) {
    return null;
  }
  return (
    <ToggleGroup
      aria-label="Artifact layout"
      onValueChange={onChange}
      size="sm"
      type="single"
      value={layout}
      variant="outline"
    >
      <ToggleGroupItem aria-label="List view" value="list">
        <ListIcon />
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Board view" value="board">
        <LayoutGridIcon />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
