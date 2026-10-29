"use client";

// Sessions -> documents: the documents slice owns the resolved-links read and
// the one reader both Details hosts share (PLN-2175).
import {
  type LinkedArtifactGroupsRender,
  ResolvedLinkedArtifactGroupsScope,
} from "@repo/app/documents/components/resolved-linked-artifact-groups-scope";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "../../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSourceOptional } from "../../data-source/provider";
import {
  type SessionLinkedArtifactHosts,
  sessionLinkedArtifactGroups,
} from "./session-linked-artifact-groups";

/**
 * The Session Details linked-artifacts table (PLN-2175 M2). `session.id` is the
 * Session artifact's UUID on the cloud read (`projections.ts` serves
 * `record.artifactId`), which `/artifact-links/resolved` accepts. The read runs
 * only under the cloud Sessions source, the shape `SessionShellCustomFieldRows`
 * uses.
 */
export function SessionLinkedArtifactGroupsScope({
  children,
  hosts,
}: Readonly<{
  children: LinkedArtifactGroupsRender;
  hosts: SessionLinkedArtifactHosts;
}>) {
  const source = useAgentSessionsDataSourceOptional();
  const readsCloud =
    source !== null &&
    agentSessionSourceSupports(
      source,
      hosts.session.id,
      AgentSessionCapability.LinkedArtifacts
    );
  return (
    <ResolvedLinkedArtifactGroupsScope
      artifactId={hosts.session.id}
      readsCloud={readsCloud}
      toGroups={(links) => sessionLinkedArtifactGroups(hosts, links)}
    >
      {children}
    </ResolvedLinkedArtifactGroupsScope>
  );
}
