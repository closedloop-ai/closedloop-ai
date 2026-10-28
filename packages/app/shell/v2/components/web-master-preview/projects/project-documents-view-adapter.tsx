"use client";

import { DocumentsViewPrototypePreview } from "@repo/app/documents/components/table/documents-view-prototype-preview"; // Cross-slice: project detail renders the DocumentsView list (ISS-12938).
import type { ProjectSummaryRow } from "@repo/app/projects/lib/project-summary-row"; // Cross-slice: project pages render the shipped project list (ISS-12938).
import { buildCreatedArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-creation";
import { AddArtifactDialog } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-creation-dialog";
import { useNavigationAdapter } from "@repo/navigation/provider";
import { useState } from "react";
import { creationConfigForKind } from "../components/specialized-artifact-list-config";
import { artifactsForProject } from "./project-artifacts";

/** Supplies the production Documents View champion with project prototype fixtures. */
export function ProjectDocumentsViewAdapter({
  addIssueOpen,
  onAddIssueOpenChange,
  project,
}: {
  addIssueOpen: boolean;
  onAddIssueOpenChange: (open: boolean) => void;
  project: ProjectSummaryRow;
}) {
  const navigationAdapter = useNavigationAdapter();
  const [artifacts, setArtifacts] = useState(() =>
    artifactsForProject(project)
  );
  const creationConfig = {
    ...creationConfigForKind("issues"),
    defaultProject: project.name,
  };
  return (
    <>
      <DocumentsViewPrototypePreview
        artifacts={artifacts}
        navigationAdapter={navigationAdapter}
        project={project}
      />
      <AddArtifactDialog
        artifacts={artifacts}
        config={creationConfig}
        customFields={[]}
        onCreate={(values) => {
          const created = buildCreatedArtifact({
            config: creationConfig,
            nextNumber: artifacts.length + 1,
            values,
          });
          setArtifacts((current) => [created, ...current]);
        }}
        onOpenChange={onAddIssueOpenChange}
        open={addIssueOpen}
      />
    </>
  );
}
