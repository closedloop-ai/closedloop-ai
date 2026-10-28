"use client";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";

export const PROJECT_TAB_VALUES = [
  "overview",
  "all",
  "documents",
  "issues",
  "plans",
  "branches",
] as const;

export type ProjectTab = (typeof PROJECT_TAB_VALUES)[number];

/** The Project Detail artifact-type switch, shared by the legacy and portable pages. */
export function ProjectTabsToggle({
  activeTab,
  onTabChange,
}: {
  activeTab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Filter by artifact type"
      onValueChange={(value) => {
        const tab = PROJECT_TAB_VALUES.find((candidate) => candidate === value);
        if (tab) {
          onTabChange(tab);
        }
      }}
      size="sm"
      type="single"
      value={activeTab}
      variant="outline"
    >
      {PROJECT_TAB_VALUES.map((tab) => (
        <ToggleGroupItem key={tab} value={tab}>
          {projectTabLabel(tab)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function projectTabLabel(tab: ProjectTab): string {
  switch (tab) {
    case "all":
      return "All Artifacts";
    case "overview":
      return "Overview";
    case "documents":
      return "PRDs";
    case "issues":
      return "Issues";
    case "plans":
      return "Plans";
    case "branches":
      return "Branches";
    default: {
      const exhaustive: never = tab;
      return exhaustive;
    }
  }
}
