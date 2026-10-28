"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  ArtifactProjectPresentation,
  ArtifactProjectValue,
} from "@repo/app/projects/components/artifact-project-value";
import { useMemo } from "react";
import { useBranchesInjectedQueryClient } from "../data-source/provider";

/**
 * ISS-10995: the Branch Details tab's Project row. Everything the row DOES is
 * {@link ArtifactProjectValue}, shared with the Session row (operator ruling
 * 2026-10-12); the extra query client is the one branch-specific part.
 *
 * `useBatchMoveArtifacts` refreshes through `useQueryClient()`, which Desktop
 * does not read Branches from: `DesktopBranchesSource` injects a Branch-owned
 * client that only the Branches context resolves, so the move's own
 * invalidation lands on a client this row never reads and the old project keeps
 * rendering (`DESKTOP_CLOUD_BRANCH_QUERY_POLICY` has `refetchOnWindowFocus`
 * off, so nothing refetches it soon). The same reason `useUpdateBranchPriority`
 * takes its client from that context. Web injects none, and the mover's own
 * pass already covers it there.
 *
 * The injected client gets the WHOLE invalidation registry rather than the
 * three Branch families this file used to name: those three were a copy of
 * `ARTIFACT_VIEW_FAMILIES`, so a desktop move refreshed them and none of the
 * other ten — `projects` and `projectTree` included (davetho review,
 * PR #8735).
 */
export function BranchProjectValue({
  artifactId,
  projectId,
  projectName,
  presentation = ArtifactProjectPresentation.Details,
  readOnly = false,
  surface,
}: Readonly<{
  artifactId: string | null;
  projectId: string | null;
  projectName: string | null;
  presentation?: ArtifactProjectPresentation;
  readOnly?: boolean;
  surface?: ArtifactStatusEditSurface;
}>) {
  const injectedQueryClient = useBranchesInjectedQueryClient();
  const extraQueryClients = useMemo(
    () => (injectedQueryClient ? [injectedQueryClient] : []),
    [injectedQueryClient]
  );
  return (
    <ArtifactProjectValue
      artifactId={artifactId}
      extraQueryClients={extraQueryClients}
      presentation={presentation}
      projectId={projectId}
      projectName={projectName}
      readOnly={readOnly}
      surface={surface}
    />
  );
}
