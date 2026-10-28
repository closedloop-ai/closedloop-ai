"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { ArrowLeftIcon, PanelRightIcon } from "lucide-react";
import {
  GenericArtifactDetailShell,
  GenericArtifactListShell,
} from "./components/artifact-shells";
import type { DetailTab } from "./components/generic-artifact-detail-shell";
import type { GenericArtifact } from "./fixtures";

/** Prop-driven portable Generic Artifact list and detail surface. */
export function GenericArtifactPreview({
  activeDetailTab,
  artifacts,
  commentsOpen,
  onActiveDetailTabChange,
  onArtifactsChange,
  onBack,
  onCommentsOpenChange,
  onOpenArtifact,
  selected,
}: Readonly<{
  activeDetailTab: DetailTab;
  artifacts: readonly GenericArtifact[];
  commentsOpen: boolean;
  onActiveDetailTabChange: (tab: DetailTab) => void;
  onArtifactsChange: (artifacts: readonly GenericArtifact[]) => void;
  onBack: () => void;
  onCommentsOpenChange: (open: boolean) => void;
  onOpenArtifact: (artifact: GenericArtifact) => void;
  selected: GenericArtifact | null;
}>) {
  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          {selected ? (
            <Button
              aria-label="Back to artifacts"
              onClick={onBack}
              size="icon-sm"
              variant="ghost"
            >
              <ArrowLeftIcon />
            </Button>
          ) : null}
          <span className="font-medium text-sm">
            {selected
              ? `${selected.slug} ${selected.title}`
              : "Generic Artifact"}
          </span>
        </div>
        {selected && activeDetailTab !== "details" ? (
          <Button
            aria-expanded={commentsOpen}
            aria-label="Toggle comments panel"
            onClick={() => onCommentsOpenChange(!commentsOpen)}
            size="icon-sm"
            variant="ghost"
          >
            <PanelRightIcon />
          </Button>
        ) : (
          <span className="text-muted-foreground text-xs">
            Visual shell reference
          </span>
        )}
      </header>
      <div className={selected ? "hidden" : "contents"}>
        <GenericArtifactListShell
          artifacts={artifacts}
          onArtifactsChange={onArtifactsChange}
          onOpenArtifact={onOpenArtifact}
        />
      </div>
      {selected ? (
        <GenericArtifactDetailShell
          artifact={selected}
          commentsOpen={commentsOpen}
          onActiveTabChange={onActiveDetailTabChange}
          onCommentsOpenChange={onCommentsOpenChange}
        />
      ) : null}
    </div>
  );
}
