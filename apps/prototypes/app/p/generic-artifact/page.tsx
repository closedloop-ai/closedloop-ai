"use client";

import type { DetailTab } from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";
import {
  type GenericArtifact,
  genericArtifacts,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { GenericArtifactPreview } from "@repo/app/shared/components/generic-artifact-surface/preview/generic-artifact-preview";
import { useState } from "react";

const GenericArtifactPrototypePage = () => {
  const [artifacts, setArtifacts] =
    useState<readonly GenericArtifact[]>(genericArtifacts);
  const [selected, setSelected] = useState<GenericArtifact | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>("artifact");
  const openArtifact = (artifact: GenericArtifact) => {
    setSelected(artifact);
    setCommentsOpen(false);
    setActiveDetailTab("artifact");
  };
  const updateArtifacts = (next: readonly GenericArtifact[]) => {
    setArtifacts(next);
    setSelected((current) =>
      current
        ? (next.find((artifact) => artifact.id === current.id) ?? current)
        : current
    );
  };

  return (
    <main>
      <GenericArtifactPreview
        activeDetailTab={activeDetailTab}
        artifacts={artifacts}
        commentsOpen={commentsOpen}
        onActiveDetailTabChange={setActiveDetailTab}
        onArtifactsChange={updateArtifacts}
        onBack={() => setSelected(null)}
        onCommentsOpenChange={setCommentsOpen}
        onOpenArtifact={openArtifact}
        selected={selected}
      />
    </main>
  );
};

export default GenericArtifactPrototypePage;
