"use client";

import {
  type AgentSessionDetail,
  type SessionLinkedArtifact,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactType,
} from "@repo/api/src/types/artifact";
// Sessions -> github: the github slice owns the canonical pull request
// lifecycle labels.
import {
  PullRequestLifecycle,
  PullRequestLifecycleLabels,
  pullRequestLifecycleLabel,
} from "@repo/app/github/lib/pull-request-lifecycle";
import type { LinkedArtifactTableGroup } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-linked-artifacts-table";
import { linkedArtifactGroups } from "@repo/app/shared/components/generic-artifact-surface/preview/components/linked-artifact-groups";
import { resolveSessionRepositoryFullName } from "../../lib/session-repository-label";
import {
  getPullRequestHref,
  pullRequestSubject,
  toTitleCase,
} from "./session-pull-request-pill";

export type SessionLinkedArtifactHosts = {
  session: AgentSessionDetail;
  buildArtifactHref?: (artifact: SessionLinkedArtifact) => string | null;
  getBranchHref?: (branchArtifactId: string) => string;
};

/**
 * The resolved links as grouped rows, plus every pull request the session
 * reports that no linked branch already draws — a pull request with no linked
 * branch included — so the table carries every PR the retired "Pull requests"
 * row showed (PLN-2175 requirement 13). Those rows open on GitHub, as that
 * row's pills did.
 */
export function sessionLinkedArtifactGroups(
  { buildArtifactHref, getBranchHref, session }: SessionLinkedArtifactHosts,
  links: readonly ArtifactLinkWithEndpoints[]
): LinkedArtifactTableGroup[] {
  const repositoryFullName = resolveSessionRepositoryFullName(session);
  return linkedArtifactGroups({
    extraPullRequests: (session.prs ?? []).map((pr) => ({
      href: getPullRequestHref(pr, repositoryFullName),
      number: String(pr.num).trim(),
      repositoryFullName,
      status: sessionPullRequestStatusLabel(pr.status),
      title: pullRequestSubject(pr),
    })),
    hrefFor: (endpoint) =>
      endpointHref(endpoint, buildArtifactHref, getBranchHref),
    links,
    pageArtifactId: session.id,
    pullRequestStatus: pullRequestLifecycleLabel,
  });
}

function endpointHref(
  endpoint: ArtifactLinkEndpoint,
  buildArtifactHref: SessionLinkedArtifactHosts["buildArtifactHref"],
  getBranchHref: SessionLinkedArtifactHosts["getBranchHref"]
): string | null {
  switch (endpoint.type) {
    case ArtifactType.Document:
      return (
        buildArtifactHref?.({
          documentType: endpoint.subtype,
          id: endpoint.id,
          name: endpoint.name,
          role: null,
          slug: endpoint.slug,
        }) ?? null
      );
    case ArtifactType.Branch:
      return getBranchHref ? getBranchHref(endpoint.id) : null;
    default:
      return null;
  }
}

/**
 * A session PR's projected status. The three lifecycle values take the
 * canonical labels; `unknown` (the projection's not-verified sentinel) and any
 * legacy value the projection passes through keep the word the retired pill
 * showed, title-cased as its CSS drew it, so an unverified PR never reads as
 * one with no status.
 */
function sessionPullRequestStatusLabel(status: string): string | null {
  const raw = status.trim();
  switch (raw.toLowerCase()) {
    case "":
      return null;
    case SessionPrLifecycleStatus.Merged:
      return PullRequestLifecycleLabels[PullRequestLifecycle.Merged];
    case SessionPrLifecycleStatus.Closed:
      return PullRequestLifecycleLabels[PullRequestLifecycle.Closed];
    case SessionPrLifecycleStatus.Open:
      return PullRequestLifecycleLabels[PullRequestLifecycle.Open];
    default:
      return toTitleCase(raw);
  }
}
