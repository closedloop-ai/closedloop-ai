import type { AgentSessionSourceArtifactSummary } from "./agent-session.ts";
import type { ArtifactType } from "./artifact.ts";

/**
 * ISS-12197: the artifact that PRODUCES this one — the source of the inbound
 * `PRODUCES` artifact link. Built on the Session source-artifact field set so
 * the two summaries cannot drift; `type` is carried because a parent may be
 * any artifact type, not only a document.
 */
export type ArtifactParentSummary = AgentSessionSourceArtifactSummary & {
  type: ArtifactType;
};
