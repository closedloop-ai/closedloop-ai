"use client";

import {
  type ArtifactLinkWithEndpoints,
  LinkDirection,
  LinkQueryMode,
} from "@repo/api/src/types/artifact";
import { useApiClientOptional } from "@repo/app/shared/api/use-api-client-optional";
import type { LinkedArtifactTableGroup } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-linked-artifacts-table";
import type { ReactNode } from "react";
import { useResolvedArtifactLinks } from "../hooks/use-artifact-links";

/** `failed`: the read errored, so `groups` is empty and not complete. */
export type LinkedArtifactGroupsRender = (
  groups: readonly LinkedArtifactTableGroup[],
  failed: boolean
) => ReactNode;

type ResolvedLinkedArtifactGroupsScopeProps = Readonly<{
  /** The page's own artifact; absent draws no table and reads nothing. */
  artifactId: string | null | undefined;
  children: LinkedArtifactGroupsRender;
  readsCloud: boolean;
  toGroups: (
    links: readonly ArtifactLinkWithEndpoints[],
    pageArtifactId: string
  ) => LinkedArtifactTableGroup[];
}>;

/**
 * A Details host's linked-artifacts table, fed from its artifact's resolved
 * links in both directions (PLN-2175). The documents slice owns the links read,
 * so the Session and Branch hosts share this one reader and keep only their
 * source check and row mapping.
 *
 * The read mounts only under the host's cloud source with an API port: desktop
 * Local mode (signed out or offline) draws no table and builds no rows from
 * local payloads (Kerensa Whitlock 2026-10-09, PLN-2175 campaign), and a mount with
 * no API port draws none rather than throwing. Nothing is drawn while the read
 * is pending, so a row the links later absorb never flashes in and out.
 */
export function ResolvedLinkedArtifactGroupsScope({
  artifactId,
  children,
  readsCloud,
  toGroups,
}: ResolvedLinkedArtifactGroupsScopeProps) {
  const apiClient = useApiClientOptional();
  if (!(readsCloud && apiClient && artifactId)) {
    return children([], false);
  }
  return (
    <ResolvedLinkedArtifactGroupsReader
      artifactId={artifactId}
      toGroups={toGroups}
    >
      {children}
    </ResolvedLinkedArtifactGroupsReader>
  );
}

function ResolvedLinkedArtifactGroupsReader({
  artifactId,
  children,
  toGroups,
}: Omit<ResolvedLinkedArtifactGroupsScopeProps, "artifactId" | "readsCloud"> & {
  artifactId: string;
}) {
  const links = useResolvedArtifactLinks(artifactId, {
    direction: LinkDirection.Both,
    mode: LinkQueryMode.Direct,
  });
  if (links.isError) {
    return children([], true);
  }
  return children(
    links.isPending ? [] : toGroups(links.data ?? [], artifactId),
    false
  );
}
