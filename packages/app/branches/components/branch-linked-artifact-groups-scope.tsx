"use client";

// Branches -> documents: the documents slice owns the resolved-links read and
// the one reader both Details hosts share (PLN-2175).
import {
  type LinkedArtifactGroupsRender,
  ResolvedLinkedArtifactGroupsScope,
} from "@repo/app/documents/components/resolved-linked-artifact-groups-scope";
import { HTTP_BRANCHES_DATA_SOURCE_SCOPE } from "../data-source/branches-data-source";
import { useBranchesDataSourceScope } from "../data-source/provider";
import {
  type BranchLinkedArtifactHosts,
  branchLinkedArtifactGroups,
} from "./branch-linked-artifact-groups";

/**
 * The Branch Details linked-artifacts table (PLN-2175 M3), keyed by the
 * branch's `artifactId`. The read runs only under the cloud Branches source:
 * desktop Local mode, whose rows carry no `artifactId`, draws no table (Kerensa
 * Whitlock 2026-10-09).
 */
export function BranchLinkedArtifactGroupsScope({
  children,
  hosts,
}: Readonly<{
  children: LinkedArtifactGroupsRender;
  hosts: BranchLinkedArtifactHosts;
}>) {
  const readsCloud =
    useBranchesDataSourceScope() === HTTP_BRANCHES_DATA_SOURCE_SCOPE;
  return (
    <ResolvedLinkedArtifactGroupsScope
      artifactId={hosts.detail.artifactId}
      readsCloud={readsCloud}
      toGroups={(links, pageArtifactId) =>
        branchLinkedArtifactGroups(hosts, links, pageArtifactId)
      }
    >
      {children}
    </ResolvedLinkedArtifactGroupsScope>
  );
}
