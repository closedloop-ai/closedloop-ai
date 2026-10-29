import {
  DETAILS_DESIGN_HOST,
  DetailsPriorityEditorHost,
} from "@repo/app/documents/components/details-design/details-design-preview-host";
import { ArtifactCanvasPanel } from "@repo/app/shared/components/artifact-detail-shell/artifact-canvas-panel";
import {
  branchDetailsTabConfig,
  documentDetailsTabConfig,
  issueDetailsTabConfig,
  sessionDetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-fixtures";
import type {
  DetailsTabArtifactType,
  DetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";

// ISS-12252, ISS-12403: the Details tab, framed for its Composites
// stories. The Session, Branch, Document and Issue Detail pages render the
// same tab.

/** The Details tab body, on the canvas card the page gives every tab. */
export function DetailsTabPanel({ config }: { config: DetailsTabConfig }) {
  return (
    <ArtifactCanvasPanel label="Details">
      <DetailsTabSections
        config={config}
        priorityEditor={DetailsPriorityEditorHost}
      />
    </ArtifactCanvasPanel>
  );
}

/** A page-height frame, so the body scrolls as it does on the page. */
export function DetailsTabFrame({ config }: { config: DetailsTabConfig }) {
  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background">
        <DetailsTabPanel config={config} />
      </div>
    </TooltipProvider>
  );
}

/** Each type's fixture config, as its Details tab reads it. */
export function detailsTabFixtureConfig(
  type: DetailsTabArtifactType
): DetailsTabConfig {
  switch (type) {
    case "session":
      return sessionDetailsTabConfig(DETAILS_DESIGN_HOST);
    case "branch":
      return branchDetailsTabConfig(DETAILS_DESIGN_HOST);
    case "document":
      return documentDetailsTabConfig(DETAILS_DESIGN_HOST);
    case "issue":
      return issueDetailsTabConfig(DETAILS_DESIGN_HOST);
    default: {
      const unhandled: never = type;
      return unhandled;
    }
  }
}
