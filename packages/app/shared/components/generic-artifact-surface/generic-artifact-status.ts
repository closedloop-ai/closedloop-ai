import { DocumentStatus, IssueStatus } from "@closedloop-ai/loops-api/document";
import {
  ARTIFACT_STATUS_ROOT,
  type ArtifactStatusRoot,
  DISPLAYED_ARTIFACT_STATUS,
  UNKNOWN_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import {
  ARTIFACT_STATUS_EDITABILITY,
  type ArtifactStatusCapability,
  type ArtifactStatusRawValue,
  ArtifactStatusReadOnlyReason,
  ArtifactStatusVocabulary,
  type ArtifactStatusVocabulary as ArtifactStatusVocabularyType,
} from "@repo/api/src/types/artifact-status-contract";
import {
  ARTIFACT_STATUS_DETAIL_LABELS,
  ARTIFACT_STATUS_DISPLAY_LABELS,
} from "@repo/api/src/types/artifact-status-display";
import { statusDisplayRank } from "@repo/api/src/types/artifact-status-display-order";
import {
  artifactStatusRootRank,
  artifactStatusRootRankOrNull,
} from "@repo/api/src/types/artifact-status-rank";
import { BranchStatus } from "@repo/api/src/types/branch";
import { branchStatusRank } from "@repo/api/src/types/branch-status-order";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { sessionStatusRank } from "@repo/api/src/types/session-status-rank";
import { artifactStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import type { ArtifactStatusFacet } from "@repo/app/shared/lib/artifact-status-view-contract";

/** Artifact kinds represented by the mock-only Generic Artifact preview. */
export const GenericArtifactKind = {
  Agent: "Agent",
  Branch: "Branch",
  Document: "Document",
  Deployment: "Deployment",
  Issue: "Issue",
  Prototype: "Prototype",
  Session: "Session",
} as const;
export type GenericArtifactKind =
  (typeof GenericArtifactKind)[keyof typeof GenericArtifactKind];

/** The preserved fixture spellings. Their semantics come only from the adapter below. */
export const GenericArtifactStatus = {
  Active: "Active",
  Approved: "Approved",
  Backlog: "Backlog",
  Blocked: "Blocked",
  Canceled: "Canceled",
  Completed: "Completed",
  Done: "Done",
  Draft: "Draft",
  Failed: "Failed",
  InProgress: "In progress",
  InReview: "In review",
  Todo: "Todo",
  Triage: "Triage",
} as const;
export type GenericArtifactStatus =
  (typeof GenericArtifactStatus)[keyof typeof GenericArtifactStatus];

export type GenericArtifactStatusSource = Readonly<{
  kind: GenericArtifactKind;
  status: GenericArtifactStatus;
  statusRaw?: string;
}>;

type StatusProfile = Readonly<{
  aliases: Readonly<
    Record<GenericArtifactStatus, ArtifactStatusRawValue | null>
  >;
  options: readonly GenericArtifactStatus[];
  vocabulary: ArtifactStatusVocabularyType;
}>;

/** Fold one fixture row through the same canonical table production consumers use. */
export function genericArtifactStatusFacet(
  source: GenericArtifactStatusSource
): ArtifactStatusFacet {
  const profile = GENERIC_ARTIFACT_STATUS_PROFILES[source.kind];
  if (source.kind === GenericArtifactKind.Deployment) {
    return {
      normalized: UNKNOWN_ARTIFACT_STATUS,
      raw: source.statusRaw ?? null,
      vocabulary: profile.vocabulary,
    };
  }
  const raw =
    source.statusRaw ?? profile.aliases[source.status] ?? source.status;
  return artifactStatusFacet(profile.vocabulary, raw);
}

/** Exact root/detail identity used by filters and saved-view state. */
export function genericArtifactStatusKey(
  source: GenericArtifactStatusSource
): string {
  const normalized = genericArtifactStatusFacet(source).normalized;
  return normalized.detail ?? normalized.root;
}

/** Human label for a root or namespaced detail key stored in view state. */
export function genericArtifactStatusKeyLabel(key: string): string {
  const legacyStatus = legacyGenericArtifactStatusFromKey(key);
  if (legacyStatus !== null) {
    return legacyStatus;
  }
  if (Object.hasOwn(ARTIFACT_STATUS_DETAIL_LABELS, key)) {
    return ARTIFACT_STATUS_DETAIL_LABELS[
      key as keyof typeof ARTIFACT_STATUS_DETAIL_LABELS
    ];
  }
  if (Object.hasOwn(ARTIFACT_STATUS_DISPLAY_LABELS, key)) {
    return ARTIFACT_STATUS_DISPLAY_LABELS[
      key as keyof typeof ARTIFACT_STATUS_DISPLAY_LABELS
    ];
  }
  return ARTIFACT_STATUS_DISPLAY_LABELS.unknown;
}

/** Admit canonical keys plus namespaced exact aliases restored from old URLs. */
export function isGenericArtifactStatusKey(key: string): boolean {
  return (
    GENERIC_ARTIFACT_STATUS_KEYS.has(key) ||
    legacyGenericArtifactStatusFromKey(key) !== null
  );
}

/** Preserve an old fixture-word URL as an exact namespaced compatibility key. */
export function genericArtifactStatusRouteKey(value: string): string | null {
  if (isGenericArtifactStatusKey(value)) {
    return value;
  }
  return GENERIC_ARTIFACT_STATUS_VALUES.has(value)
    ? `${LEGACY_GENERIC_ARTIFACT_STATUS_KEY_PREFIX}${value}`
    : null;
}

/** Root identity used by groups and board lanes. */
export function genericArtifactStatusRoot(
  source: GenericArtifactStatusSource
): string {
  return genericArtifactStatusFacet(source).normalized.root;
}

/** Semantic root order, never localized-label order. */
export function genericArtifactStatusRank(
  source: GenericArtifactStatusSource
): number | null {
  return artifactStatusRootRankOrNull(
    genericArtifactStatusFacet(source).normalized.root
  );
}

/** Root-only, detail, and legacy compatibility selections are all exact. */
export function genericArtifactStatusMatchesKey(
  source: GenericArtifactStatusSource,
  key: string
): boolean {
  const legacyStatus = legacyGenericArtifactStatusFromKey(key);
  if (legacyStatus !== null) {
    return source.status === legacyStatus;
  }
  const normalized = genericArtifactStatusFacet(source).normalized;
  return normalized.detail
    ? key === normalized.detail
    : key === normalized.root;
}

/** Multiple status selections are an OR over exact roots/details. */
export function genericArtifactStatusMatchesAny(
  source: GenericArtifactStatusSource,
  keys: readonly string[]
): boolean {
  return (
    keys.length === 0 ||
    keys.some((key) => genericArtifactStatusMatchesKey(source, key))
  );
}

/** Kind-valid fixture options, with duplicate aliases removed at the profile boundary. */
export function genericArtifactStatusOptions(
  kind: GenericArtifactKind
): readonly GenericArtifactStatus[] {
  return GENERIC_ARTIFACT_STATUS_PROFILES[kind].options;
}

/** The five root facets used by mixed board lanes. */
export function genericArtifactRootFacets(
  representedKinds: readonly GenericArtifactKind[]
): ArtifactStatusFacet[] {
  const facets = new Map<string, ArtifactStatusFacet>();
  for (const kind of representedKinds) {
    for (const status of genericArtifactStatusOptions(kind)) {
      const facet = genericArtifactStatusFacet({ kind, status });
      if (facet.normalized === UNKNOWN_ARTIFACT_STATUS) {
        continue;
      }
      const rootFacet = {
        normalized: { root: facet.normalized.root },
        raw: null,
        vocabulary: facet.vocabulary,
      } satisfies ArtifactStatusFacet;
      facets.set(facet.normalized.root, rootFacet);
    }
  }
  return [...facets.values()].sort(
    (left, right) =>
      artifactStatusRootRank(left.normalized.root) -
      artifactStatusRootRank(right.normalized.root)
  );
}

/** One root-only facet for a mixed board/group heading. */
export function genericArtifactRootFacet(
  root: string,
  representedKinds: readonly GenericArtifactKind[] = Object.values(
    GenericArtifactKind
  )
): ArtifactStatusFacet | null {
  if (root === DISPLAYED_ARTIFACT_STATUS.Unknown) {
    const kind = representedKinds[0] ?? GenericArtifactKind.Issue;
    return {
      normalized: UNKNOWN_ARTIFACT_STATUS,
      raw: null,
      vocabulary: GENERIC_ARTIFACT_STATUS_PROFILES[kind].vocabulary,
    };
  }
  return (
    genericArtifactRootFacets(representedKinds).find(
      (facet) => facet.normalized.root === root
    ) ?? null
  );
}

/** Resolve a stored exact filter key back to a canonical facet. */
export function genericArtifactFacetForKey(
  representedKinds: readonly GenericArtifactKind[],
  key: string
): ArtifactStatusFacet | null {
  const root = genericArtifactRootFacet(key, representedKinds);
  if (root) {
    return root;
  }
  for (const kind of representedKinds) {
    for (const status of genericArtifactStatusOptions(kind)) {
      const source = { kind, status };
      if (genericArtifactStatusKey(source) === key) {
        return genericArtifactStatusFacet(source);
      }
    }
  }
  return null;
}

/** Ordered filter values: each root immediately followed by its exact details. */
export function genericArtifactFilterKeys(
  representedKinds: readonly GenericArtifactKind[],
  includeUnknown = false
): string[] {
  const ordered: string[] = [];
  for (const rootFacet of genericArtifactRootFacets(representedKinds)) {
    ordered.push(rootFacet.normalized.root);
    const details = new Set<string>();
    for (const kind of representedKinds) {
      for (const status of genericArtifactStatusOptions(kind)) {
        const source = { kind, status };
        const facet = genericArtifactStatusFacet(source);
        if (
          facet.normalized.root === rootFacet.normalized.root &&
          facet.normalized.detail
        ) {
          details.add(genericArtifactStatusKey(source));
        }
      }
    }
    ordered.push(...details);
  }
  if (includeUnknown) {
    ordered.push(DISPLAYED_ARTIFACT_STATUS.Unknown);
  }
  return ordered;
}

/** Map a canonical editor target back to the fixture alias stored by the preview. */
export function genericArtifactStatusFromRaw(
  kind: GenericArtifactKind,
  raw: string
): GenericArtifactStatus | null {
  const profile = GENERIC_ARTIFACT_STATUS_PROFILES[kind];
  return (
    profile.options.find((status) => profile.aliases[status] === raw) ?? null
  );
}

/** Resolve a root move without erasing an existing detail or inventing one. */
export function genericArtifactStatusForRoot(
  source: GenericArtifactStatusSource,
  root: string
): GenericArtifactStatus | null {
  const current = genericArtifactStatusFacet(source).normalized;
  if (current.root === root) {
    return source.status;
  }
  if (
    !Object.values(ARTIFACT_STATUS_ROOT).includes(root as ArtifactStatusRoot)
  ) {
    return null;
  }
  return (
    GENERIC_ARTIFACT_ROOT_DEFAULTS[source.kind][root as ArtifactStatusRoot] ??
    null
  );
}

/** Kind-valid default used when creation starts from a root rather than a row. */
export function genericArtifactStatusDefaultForRoot(
  kind: GenericArtifactKind,
  root: string
): GenericArtifactStatus | null {
  if (
    !Object.values(ARTIFACT_STATUS_ROOT).includes(root as ArtifactStatusRoot)
  ) {
    return null;
  }
  return (
    GENERIC_ARTIFACT_ROOT_DEFAULTS[kind][root as ArtifactStatusRoot] ?? null
  );
}

/** Fixture alias for an exact root/detail key restored from filters or views. */
export function genericArtifactStatusForKey(
  kind: GenericArtifactKind,
  key: string
): GenericArtifactStatus | null {
  return (
    genericArtifactStatusOptions(kind).find(
      (status) => genericArtifactStatusKey({ kind, status }) === key
    ) ?? null
  );
}

/** Resolve only an exact raw target; a parent cannot imply a document detail. */
export function genericArtifactStatusForSelection(
  source: GenericArtifactStatusSource,
  key: string
): GenericArtifactStatus | null {
  return genericArtifactStatusCapability(source).editable
    ? genericArtifactStatusForKey(source.kind, key)
    : null;
}

/** Canonical bulk options shared by every selected editable vocabulary. */
export function genericArtifactCompatibleStatusOptions(
  sources: readonly GenericArtifactStatusSource[]
): readonly Readonly<{ facet: ArtifactStatusFacet; key: string }>[] {
  if (
    sources.length === 0 ||
    sources.some((source) => !genericArtifactStatusCapability(source).editable)
  ) {
    return [];
  }
  const firstKind = sources[0]!.kind;
  return genericArtifactFilterKeys([firstKind]).flatMap((key) => {
    if (
      sources.some(
        (source) => genericArtifactStatusForSelection(source, key) === null
      )
    ) {
      return [];
    }
    const facet = genericArtifactFacetForKey([firstKind], key);
    return facet ? [{ facet, key }] : [];
  });
}

/** Per-row editability and canonical targets for the preview's champion editor. */
export function genericArtifactStatusCapability(
  source: GenericArtifactStatusSource
): ArtifactStatusCapability {
  const profile = GENERIC_ARTIFACT_STATUS_PROFILES[source.kind];
  const editability = ARTIFACT_STATUS_EDITABILITY[profile.vocabulary];
  if (!editability.editable) {
    return editability;
  }
  if (
    genericArtifactStatusFacet(source).normalized === UNKNOWN_ARTIFACT_STATUS
  ) {
    return {
      editable: false,
      reason: ArtifactStatusReadOnlyReason.UnrecognizedStatus,
    };
  }
  return {
    editable: true as const,
    allowedTargets: [
      ...new Set(
        profile.options.flatMap((status) => {
          const raw = profile.aliases[status];
          return raw === null ? [] : [raw];
        })
      ),
    ],
  };
}

/** Current raw evidence for a fixture row, including provider-derived overrides. */
export function genericArtifactStatusRaw(
  source: GenericArtifactStatusSource
): string | null {
  const profile = GENERIC_ARTIFACT_STATUS_PROFILES[source.kind];
  return source.statusRaw ?? profile.aliases[source.status];
}

function aliases(
  overrides: Partial<
    Record<GenericArtifactStatus, ArtifactStatusRawValue | null>
  >
): Readonly<Record<GenericArtifactStatus, ArtifactStatusRawValue | null>> {
  return Object.freeze({
    [GenericArtifactStatus.Active]: null,
    [GenericArtifactStatus.Approved]: null,
    [GenericArtifactStatus.Backlog]: null,
    [GenericArtifactStatus.Blocked]: null,
    [GenericArtifactStatus.Canceled]: null,
    [GenericArtifactStatus.Completed]: null,
    [GenericArtifactStatus.Done]: null,
    [GenericArtifactStatus.Draft]: null,
    [GenericArtifactStatus.Failed]: null,
    [GenericArtifactStatus.InProgress]: null,
    [GenericArtifactStatus.InReview]: null,
    [GenericArtifactStatus.Todo]: null,
    [GenericArtifactStatus.Triage]: null,
    ...overrides,
  });
}

const DOCUMENT_ALIASES = aliases({
  [GenericArtifactStatus.Active]: DocumentStatus.Draft,
  [GenericArtifactStatus.Approved]: DocumentStatus.Approved,
  [GenericArtifactStatus.Blocked]: DocumentStatus.ChangesRequested,
  [GenericArtifactStatus.Canceled]: DocumentStatus.Obsolete,
  [GenericArtifactStatus.Completed]: DocumentStatus.Executed,
  [GenericArtifactStatus.Done]: DocumentStatus.Approved,
  [GenericArtifactStatus.Draft]: DocumentStatus.Draft,
  [GenericArtifactStatus.InProgress]: DocumentStatus.Draft,
  [GenericArtifactStatus.InReview]: DocumentStatus.InReview,
});

const ISSUE_ALIASES = aliases({
  [GenericArtifactStatus.Active]: IssueStatus.InProgress,
  [GenericArtifactStatus.Approved]: IssueStatus.Done,
  [GenericArtifactStatus.Backlog]: IssueStatus.Backlog,
  [GenericArtifactStatus.Blocked]: IssueStatus.Blocked,
  [GenericArtifactStatus.Canceled]: IssueStatus.Canceled,
  [GenericArtifactStatus.Completed]: IssueStatus.Done,
  [GenericArtifactStatus.Done]: IssueStatus.Done,
  [GenericArtifactStatus.Draft]: IssueStatus.Todo,
  [GenericArtifactStatus.InProgress]: IssueStatus.InProgress,
  [GenericArtifactStatus.InReview]: IssueStatus.InReview,
  [GenericArtifactStatus.Todo]: IssueStatus.Todo,
  [GenericArtifactStatus.Triage]: IssueStatus.Triage,
});

const BRANCH_ALIASES = aliases({
  [GenericArtifactStatus.Active]: BranchStatus.Open,
  [GenericArtifactStatus.Approved]: BranchStatus.Merged,
  [GenericArtifactStatus.Blocked]: BranchStatus.Blocked,
  [GenericArtifactStatus.Canceled]: BranchStatus.Closed,
  [GenericArtifactStatus.Completed]: BranchStatus.Merged,
  [GenericArtifactStatus.Done]: BranchStatus.Merged,
  [GenericArtifactStatus.Draft]: BranchStatus.Draft,
  [GenericArtifactStatus.InProgress]: BranchStatus.Draft,
  [GenericArtifactStatus.InReview]: BranchStatus.Review,
});

const SESSION_ALIASES = aliases({
  [GenericArtifactStatus.Active]: SESSION_STATUS.ACTIVE,
  [GenericArtifactStatus.Completed]: SESSION_STATUS.INACTIVE,
  [GenericArtifactStatus.Done]: SESSION_STATUS.INACTIVE,
  [GenericArtifactStatus.Failed]: SESSION_STATUS.ERROR,
  [GenericArtifactStatus.InProgress]: SESSION_STATUS.ACTIVE,
});

const GENERIC_ARTIFACT_STATUS_PROFILES: Readonly<
  Record<GenericArtifactKind, StatusProfile>
> = Object.freeze({
  [GenericArtifactKind.Agent]: Object.freeze({
    aliases: ISSUE_ALIASES,
    options: [
      GenericArtifactStatus.Triage,
      GenericArtifactStatus.Backlog,
      GenericArtifactStatus.Todo,
      GenericArtifactStatus.InProgress,
      GenericArtifactStatus.InReview,
      GenericArtifactStatus.Blocked,
      GenericArtifactStatus.Done,
      GenericArtifactStatus.Canceled,
    ],
    vocabulary: ArtifactStatusVocabulary.Issue,
  }),
  [GenericArtifactKind.Branch]: Object.freeze({
    aliases: BRANCH_ALIASES,
    options: [
      GenericArtifactStatus.Active,
      GenericArtifactStatus.Draft,
      GenericArtifactStatus.InReview,
      GenericArtifactStatus.Blocked,
      GenericArtifactStatus.Done,
      GenericArtifactStatus.Canceled,
    ],
    vocabulary: ArtifactStatusVocabulary.Branch,
  }),
  [GenericArtifactKind.Deployment]: Object.freeze({
    aliases: aliases({}),
    options: [],
    vocabulary: ArtifactStatusVocabulary.Branch,
  }),
  [GenericArtifactKind.Document]: Object.freeze({
    aliases: DOCUMENT_ALIASES,
    options: [
      GenericArtifactStatus.Draft,
      GenericArtifactStatus.InReview,
      GenericArtifactStatus.Blocked,
      GenericArtifactStatus.Approved,
      GenericArtifactStatus.Completed,
      GenericArtifactStatus.Canceled,
    ],
    vocabulary: ArtifactStatusVocabulary.Document,
  }),
  [GenericArtifactKind.Issue]: Object.freeze({
    aliases: ISSUE_ALIASES,
    options: [
      GenericArtifactStatus.Triage,
      GenericArtifactStatus.Backlog,
      GenericArtifactStatus.Todo,
      GenericArtifactStatus.InProgress,
      GenericArtifactStatus.InReview,
      GenericArtifactStatus.Blocked,
      GenericArtifactStatus.Done,
      GenericArtifactStatus.Canceled,
    ],
    vocabulary: ArtifactStatusVocabulary.Issue,
  }),
  [GenericArtifactKind.Prototype]: Object.freeze({
    aliases: ISSUE_ALIASES,
    options: [
      GenericArtifactStatus.Triage,
      GenericArtifactStatus.Backlog,
      GenericArtifactStatus.Todo,
      GenericArtifactStatus.InProgress,
      GenericArtifactStatus.InReview,
      GenericArtifactStatus.Blocked,
      GenericArtifactStatus.Done,
      GenericArtifactStatus.Canceled,
    ],
    vocabulary: ArtifactStatusVocabulary.Issue,
  }),
  [GenericArtifactKind.Session]: Object.freeze({
    aliases: SESSION_ALIASES,
    options: [
      GenericArtifactStatus.Active,
      GenericArtifactStatus.Completed,
      GenericArtifactStatus.Failed,
    ],
    vocabulary: ArtifactStatusVocabulary.Session,
  }),
});

const GENERIC_ARTIFACT_STATUS_KEYS: ReadonlySet<string> = new Set([
  DISPLAYED_ARTIFACT_STATUS.Unknown,
  ...Object.values(GenericArtifactKind).flatMap((kind) =>
    genericArtifactStatusOptions(kind).map((status) =>
      genericArtifactStatusKey({ kind, status })
    )
  ),
]);

const LEGACY_GENERIC_ARTIFACT_STATUS_KEY_PREFIX = "legacy-preview:";
const GENERIC_ARTIFACT_STATUS_VALUES: ReadonlySet<string> = new Set(
  Object.values(GenericArtifactStatus)
);

const ISSUE_ROOT_DEFAULTS = Object.freeze({
  [ARTIFACT_STATUS_ROOT.Todo]: GenericArtifactStatus.Todo,
  [ARTIFACT_STATUS_ROOT.InProgress]: GenericArtifactStatus.InProgress,
  [ARTIFACT_STATUS_ROOT.InReview]: GenericArtifactStatus.InReview,
  [ARTIFACT_STATUS_ROOT.Done]: GenericArtifactStatus.Done,
  [ARTIFACT_STATUS_ROOT.Canceled]: GenericArtifactStatus.Canceled,
});

const GENERIC_ARTIFACT_ROOT_DEFAULTS: Readonly<
  Record<
    GenericArtifactKind,
    Readonly<Partial<Record<ArtifactStatusRoot, GenericArtifactStatus>>>
  >
> = Object.freeze({
  [GenericArtifactKind.Agent]: ISSUE_ROOT_DEFAULTS,
  [GenericArtifactKind.Branch]: Object.freeze({}),
  [GenericArtifactKind.Deployment]: Object.freeze({}),
  [GenericArtifactKind.Document]: Object.freeze({
    [ARTIFACT_STATUS_ROOT.InReview]: GenericArtifactStatus.InReview,
  }),
  [GenericArtifactKind.Issue]: ISSUE_ROOT_DEFAULTS,
  [GenericArtifactKind.Prototype]: ISSUE_ROOT_DEFAULTS,
  [GenericArtifactKind.Session]: Object.freeze({}),
});

/** Canonical display copy for one fixture alias or exact raw value. */
export function genericArtifactStatusLabel(
  source: GenericArtifactStatusSource
): string {
  return genericArtifactStatusKeyLabel(genericArtifactStatusKey(source));
}

/** Canonical per-vocabulary order beneath a shared normalized root. */
export function genericArtifactStatusRawRank(
  source: GenericArtifactStatusSource
): number | null {
  const facet = genericArtifactStatusFacet(source);
  const raw = genericArtifactStatusRaw(source);
  if (facet.normalized === UNKNOWN_ARTIFACT_STATUS || raw === null) {
    return null;
  }
  switch (facet.vocabulary) {
    case ArtifactStatusVocabulary.Branch:
      return branchStatusRank(raw);
    case ArtifactStatusVocabulary.Document:
    case ArtifactStatusVocabulary.Issue:
      return statusDisplayRank(raw);
    case ArtifactStatusVocabulary.Session:
      return sessionStatusRank(raw);
    case ArtifactStatusVocabulary.Project:
      return null;
    default:
      return assertNeverArtifactStatusVocabulary(facet.vocabulary);
  }
}

function assertNeverArtifactStatusVocabulary(value: never): never {
  throw new Error(`Unhandled artifact status vocabulary: ${value}`);
}

function legacyGenericArtifactStatusFromKey(
  key: string
): GenericArtifactStatus | null {
  if (!key.startsWith(LEGACY_GENERIC_ARTIFACT_STATUS_KEY_PREFIX)) {
    return null;
  }
  const value = key.slice(LEGACY_GENERIC_ARTIFACT_STATUS_KEY_PREFIX.length);
  return GENERIC_ARTIFACT_STATUS_VALUES.has(value)
    ? (value as GenericArtifactStatus)
    : null;
}
