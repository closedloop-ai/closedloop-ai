import {
  CHANNEL_SEGMENT_SEPARATOR,
  ChannelKind,
} from "@repo/realtime-contract/channels";
import {
  GRANT_WILDCARD,
  type Grant,
  GrantAccess,
} from "@repo/realtime-contract/grants";

export type RealtimeGrantContext = {
  organizationId: string;
  userId: string;
};

/**
 * The grants a realtime token carries for `context`, one policy entry per
 * channel kind (PLN-2103 decision 5).
 */
export function buildRealtimeGrants(context: RealtimeGrantContext): Grant[] {
  return Object.values(REALTIME_GRANT_POLICY).flatMap((grantsFor) =>
    grantsFor(context)
  );
}

/**
 * Where a channel kind is declared: `Record<ChannelKind, …>` makes a new kind
 * fail `tsc` until it states who may join it. A kind nobody grants cannot be
 * joined, so the kind-opaque service needs no kind list (PLN-2103 decision 5).
 */
const REALTIME_GRANT_POLICY: Record<
  ChannelKind,
  (context: RealtimeGrantContext) => Grant[]
> = {
  [ChannelKind.Branches]: ({ organizationId }) => [
    {
      pattern: [ChannelKind.Branches, organizationId, GRANT_WILDCARD].join(
        CHANNEL_SEGMENT_SEPARATOR
      ),
      access: GrantAccess.Read,
    },
  ],
  // Comments are readable across the whole organization (PLN-2103 decision 5).
  // `*` matches exactly one final segment, so this covers the spec's
  // single-segment `comments:{org}:{artifactId}` channel and nothing deeper.
  [ChannelKind.Comments]: ({ organizationId }) => [
    {
      pattern: [ChannelKind.Comments, organizationId, GRANT_WILDCARD].join(
        CHANNEL_SEGMENT_SEPARATOR
      ),
      access: GrantAccess.Read,
    },
  ],
  // PLN-2099 E4: document grants come only from `/doc-sync/token`.
  [ChannelKind.Document]: () => [],
  // PLN-2190: readable org-wide like comments (PLN-2103 decision 5). The
  // signal names a version number only; content is read through the document
  // API, which applies its own access check.
  [ChannelKind.DocumentVersions]: ({ organizationId }) => [
    {
      pattern: [
        ChannelKind.DocumentVersions,
        organizationId,
        GRANT_WILDCARD,
      ].join(CHANNEL_SEGMENT_SEPARATOR),
      access: GrantAccess.Read,
    },
  ],
};
