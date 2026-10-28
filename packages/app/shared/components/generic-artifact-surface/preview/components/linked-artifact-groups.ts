import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactSubtype,
  ArtifactType,
  LinkType,
  type PullRequestDetail,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import type { LucideIcon } from "lucide-react";
import { ArtifactTypeIcons, GenericArtifactIcon } from "./artifact-icons";
import type {
  LinkedArtifactTableGroup,
  LinkedArtifactTableRow,
} from "./artifact-linked-artifacts-table";

/** Which end of a link the page's own artifact sits on. */
export const LinkEnd = {
  Source: "source",
  Target: "target",
} as const;
export type LinkEnd = (typeof LinkEnd)[keyof typeof LinkEnd];

/**
 * The Relationship column, read as "This [page artifact] [label] [row]"
 * (Kerensa Whitlock 2026-10-09, PLN-2175 requirement 7).
 */
export const LINKED_ARTIFACT_RELATIONSHIP_LABELS: Readonly<
  Record<LinkType, Readonly<Record<LinkEnd, string>>>
> = {
  [LinkType.Produces]: {
    [LinkEnd.Source]: "Produces",
    [LinkEnd.Target]: "Produced by",
  },
  [LinkType.Blocks]: {
    [LinkEnd.Source]: "Blocking",
    [LinkEnd.Target]: "Blocked by",
  },
  [LinkType.RelatesTo]: {
    [LinkEnd.Source]: "Related to",
    [LinkEnd.Target]: "Related to",
  },
};

/** One heading per far-endpoint type (Kerensa Whitlock 2026-10-09, PLN-2175 campaign). */
export const LINKED_ARTIFACT_GROUP_HEADINGS: Readonly<
  Record<ArtifactType, string>
> = {
  [ArtifactType.Document]: "Documents",
  [ArtifactType.Branch]: "Branches & pull requests",
  [ArtifactType.Session]: "Sessions",
  [ArtifactType.Deployment]: "Deployments",
};

/**
 * Issues are Documents on the wire (subtype FEATURE), but the Details tab lists
 * them under their own heading (ISS-12412: Documents, Sessions, Issues,
 * Branches & pull requests).
 */
export const LINKED_ARTIFACT_ISSUES_GROUP = {
  heading: "Issues",
  key: "issue",
} as const;

/**
 * A pull request the host knows of beside the resolved links. It draws under
 * the Branch group unless a linked branch already draws it as its current pull
 * request; it states no relationship, because no link row stands behind it.
 */
export type LinkedArtifactExtraPullRequest = {
  number: string;
  /** Compared only when the linked pull request names one too. */
  repositoryFullName: string | null;
  /** `""` when the pull request has no subject of its own. */
  title: string;
  status: string | null;
  href: string | null;
};

/**
 * The page's resolved links as grouped rows (PLN-2175 M1).
 *
 * The far endpoint is whichever end is not the page. Rows collapse on (far
 * artifact, link type, page end), because one artifact commonly holds several
 * link rows to the same branch. A Branch whose current pull request is known is
 * drawn as that pull request. A link type or far type this build does not know
 * still draws: the first with a blank relationship, the second under its own
 * wire type. Rows keep the order the links arrived in; `extraPullRequests`
 * follow the Branch group's resolved rows. The host supplies each destination
 * and each pull request's state label.
 */
export function linkedArtifactGroups({
  extraPullRequests = [],
  hrefFor,
  links,
  pageArtifactId,
  pullRequestStatus,
}: {
  extraPullRequests?: readonly LinkedArtifactExtraPullRequest[];
  hrefFor: (endpoint: ArtifactLinkEndpoint) => string | null;
  links: readonly ArtifactLinkWithEndpoints[];
  pageArtifactId: string;
  pullRequestStatus: (pullRequest: PullRequestDetail) => string | null;
}): LinkedArtifactTableGroup[] {
  const rowsByType = new Map<string, LinkedArtifactTableRow[]>();
  const add = (type: string, row: LinkedArtifactTableRow) => {
    const rows = rowsByType.get(type);
    if (rows) {
      rows.push(row);
    } else {
      rowsByType.set(type, [row]);
    }
  };
  const seen = new Set<string>();
  const drawn: PullRequestDetail[] = [];
  for (const link of links) {
    const end = pageEnd(link, pageArtifactId);
    if (end === null) {
      continue;
    }
    const far = end === LinkEnd.Source ? link.target : link.source;
    const key = `${far.id}:${link.linkType}:${end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const pullRequest = currentPullRequest(far);
    if (pullRequest) {
      drawn.push(pullRequest);
    }
    add(groupKey(far), {
      ...endpointIdentity(far, pullRequest, pullRequestStatus),
      href: hrefFor(far),
      key,
      relationship: relationshipLabel(link.linkType, end),
    });
  }
  for (const row of extraPullRequestRows(extraPullRequests, drawn)) {
    add(ArtifactType.Branch, row);
  }
  return [...rowsByType]
    .map(([type, rows]) => ({
      heading: linkedArtifactGroupHeading(type),
      key: type,
      rows,
    }))
    .sort(compareGroups);
}

function groupKey(far: Pick<ArtifactLinkEndpoint, "subtype" | "type">) {
  return far.type === ArtifactType.Document &&
    far.subtype === ArtifactSubtype.Feature
    ? LINKED_ARTIFACT_ISSUES_GROUP.key
    : far.type;
}

/** A group key's heading: production's word, or the wire type itself. */
export function linkedArtifactGroupHeading(key: string): string {
  if (key === LINKED_ARTIFACT_ISSUES_GROUP.key) {
    return LINKED_ARTIFACT_ISSUES_GROUP.heading;
  }
  return isArtifactType(key) ? LINKED_ARTIFACT_GROUP_HEADINGS[key] : key;
}

function currentPullRequest(
  far: ArtifactLinkEndpoint
): PullRequestDetail | null {
  return far.type === ArtifactType.Branch
    ? (far.branch?.currentPullRequest ?? null)
    : null;
}

function pageEnd(
  link: ArtifactLinkWithEndpoints,
  pageArtifactId: string
): LinkEnd | null {
  if (link.sourceId === pageArtifactId) {
    return LinkEnd.Source;
  }
  return link.targetId === pageArtifactId ? LinkEnd.Target : null;
}

function relationshipLabel(linkType: string, end: LinkEnd): string | null {
  return isLinkType(linkType)
    ? LINKED_ARTIFACT_RELATIONSHIP_LABELS[linkType][end]
    : null;
}

function endpointIdentity(
  far: ArtifactLinkEndpoint,
  pullRequest: PullRequestDetail | null,
  pullRequestStatus: (pullRequest: PullRequestDetail) => string | null
): Pick<LinkedArtifactTableRow, "icon" | "name" | "slug" | "status"> {
  if (pullRequest) {
    return pullRequestIdentity(
      pullRequest.number,
      pullRequest.title || far.branch?.branchName || far.name,
      pullRequestStatus(pullRequest)
    );
  }
  return {
    icon: endpointIcon(far),
    name:
      (far.type === ArtifactType.Branch ? far.branch?.branchName : null) ||
      far.name,
    slug: far.slug,
  };
}

function endpointIcon(
  far: Pick<ArtifactLinkEndpoint, "subtype" | "type">
): LucideIcon {
  switch (far.type) {
    case ArtifactType.Document:
      return far.subtype === ArtifactSubtype.Feature
        ? ArtifactTypeIcons.Issue
        : ArtifactTypeIcons.Document;
    case ArtifactType.Branch:
      return ArtifactTypeIcons.Branch;
    case ArtifactType.Session:
      return ArtifactTypeIcons.Session;
    default:
      return GenericArtifactIcon;
  }
}

/** Known types in heading order, then unknown ones by their wire type. */
function compareGroups(
  a: LinkedArtifactTableGroup,
  b: LinkedArtifactTableGroup
): number {
  const rank = (key: string) =>
    Object.hasOwn(GROUP_RANK, key)
      ? GROUP_RANK[key as LinkedArtifactGroupKey]
      : UNKNOWN_GROUP_RANK;
  return rank(a.key) - rank(b.key) || a.key.localeCompare(b.key);
}

type LinkedArtifactGroupKey =
  | ArtifactType
  | typeof LINKED_ARTIFACT_ISSUES_GROUP.key;

/** The Details tab's order (ISS-12412), then Deployments. */
const GROUP_RANK: Readonly<Record<LinkedArtifactGroupKey, number>> = {
  [ArtifactType.Document]: 0,
  [ArtifactType.Session]: 1,
  [LINKED_ARTIFACT_ISSUES_GROUP.key]: 2,
  [ArtifactType.Branch]: 3,
  [ArtifactType.Deployment]: 4,
};
const UNKNOWN_GROUP_RANK = Object.keys(GROUP_RANK).length;

/** Every known group key, in the order the table draws them. */
export const LINKED_ARTIFACT_GROUP_ORDER = (
  Object.keys(GROUP_RANK) as LinkedArtifactGroupKey[]
).sort((a, b) => GROUP_RANK[a] - GROUP_RANK[b]);

function isArtifactType(value: string): value is ArtifactType {
  return Object.hasOwn(LINKED_ARTIFACT_GROUP_HEADINGS, value);
}

function isLinkType(value: string): value is LinkType {
  return Object.hasOwn(LINKED_ARTIFACT_RELATIONSHIP_LABELS, value);
}

/** One row shape for a pull request, whether a linked branch or the host draws it. */
function pullRequestIdentity(
  number: number | string,
  name: string,
  status: string | null
): Pick<LinkedArtifactTableRow, "icon" | "name" | "slug" | "status"> {
  return { icon: ArtifactTypeIcons.Branch, name, slug: `#${number}`, status };
}

function extraPullRequestRows(
  extras: readonly LinkedArtifactExtraPullRequest[],
  drawn: readonly PullRequestDetail[]
): LinkedArtifactTableRow[] {
  const rows: LinkedArtifactTableRow[] = [];
  const added = new Set<string>();
  for (const extra of extras) {
    const repository = extra.repositoryFullName
      ? normalizeRepoFullName(extra.repositoryFullName)
      : "";
    const key = `pull-request:${repository}#${extra.number}`;
    if (
      added.has(key) ||
      drawn.some((current) => isSamePullRequest(current, extra))
    ) {
      continue;
    }
    added.add(key);
    rows.push({
      ...pullRequestIdentity(extra.number, extra.title, extra.status),
      href: extra.href,
      key,
      relationship: null,
    });
  }
  return rows;
}

/**
 * Same number, then the canonical URL when both sides carry one, else the
 * repository when both name one. With neither, the two are not proven to be
 * one pull request, so both rows stay: an App-backed row can arrive with a null
 * repository and must not hide another repository's PR of the same number.
 */
function isSamePullRequest(
  current: PullRequestDetail,
  extra: LinkedArtifactExtraPullRequest
): boolean {
  if (String(current.number) !== extra.number) {
    return false;
  }
  const currentUrl = current.htmlUrl ?? null;
  if (currentUrl && extra.href) {
    return (
      normalizePullRequestUrl(currentUrl) ===
      normalizePullRequestUrl(extra.href)
    );
  }
  const currentRepository = current.repositoryFullName ?? null;
  if (currentRepository && extra.repositoryFullName) {
    return (
      normalizeRepoFullName(currentRepository) ===
      normalizeRepoFullName(extra.repositoryFullName)
    );
  }
  return false;
}

function normalizePullRequestUrl(url: string): string {
  return url.trim().replace(PULL_REQUEST_URL_SUFFIX, "").toLowerCase();
}

const PULL_REQUEST_URL_SUFFIX = /\/*(?:[?#].*)?$/;
