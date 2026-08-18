"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { ArrowLeftIcon, PanelRightIcon } from "lucide-react";
import { useState } from "react";
import {
  GenericArtifactDetailShell,
  GenericArtifactListShell,
} from "./components/artifact-shells";
import { type GenericArtifact, genericArtifacts } from "./mock";

const GenericArtifactPrototypePage = () => {
  const [artifacts, setArtifacts] =
    useState<readonly GenericArtifact[]>(genericArtifacts);
  const [selected, setSelected] = useState<GenericArtifact | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState<
    "artifact" | "details" | "sessions"
  >("artifact");
  const openDetail = (artifact: GenericArtifact) => {
    setActiveDetailTab("artifact");
    setCommentsOpen(false);
    setSelected(artifact);
  };
  const handleArtifactsChange = (next: readonly GenericArtifact[]) => {
    setArtifacts(next);
    setSelected((current) =>
      current
        ? (next.find((artifact) => artifact.id === current.id) ?? current)
        : current
    );
  };

  return (
    <main className="flex h-svh flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          {selected ? (
            <Button
              aria-label="Back to artifacts"
              onClick={() => setSelected(null)}
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
            onClick={() => setCommentsOpen((open) => !open)}
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
          onArtifactsChange={handleArtifactsChange}
          onOpenArtifact={openDetail}
        />
      </div>
      {selected ? (
        <GenericArtifactDetailShell
          artifact={selected}
          commentsOpen={commentsOpen}
          onActiveTabChange={setActiveDetailTab}
          onCommentsOpenChange={setCommentsOpen}
        />
      ) : null}
    </main>
  );
};

export default GenericArtifactPrototypePage;
