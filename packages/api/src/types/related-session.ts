/**
 * ISS-7235 — the wire contract for the read-only Related Sessions field.
 *
 * Deliberately import-light: the only import is the sibling relationship
 * vocabulary, which is itself dependency-free. The `"use client"` cell that
 * renders these rows must be able to import the shape and the display cap
 * without pulling a Zod parser into the bundle, the same split
 * `session-status.ts` / `session-status-display.ts` makes.
 *
 * Eligibility — which sessions appear here at all — is NOT restated in this
 * module. It is `listEligibleSessionArtifactIds` /
 * `listEligibleSessionContributions` in
 * `apps/api/app/agent-sessions/service/provenance-eligibility.ts`, the one query
 * ISS-7234 built for exactly this reason.
 */
import { ArtifactType } from "./artifact.ts";
import { BRANCH_LIST_SERVER_PAGE_SIZE_MAX } from "./branch-list-contract.ts";
import type { ProvenanceRelationshipKind } from "./provenance-relationship.ts";

/**
 * The name parts and avatar a provenance pill renders — deliberately NOT
 * `BasicUser`, which also carries `email`. See {@link RelatedSessionSummary.owner}.
 */
export type RelatedSessionOwner = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

/**
 * One session that contributed to, or commented on, an artifact.
 *
 * `contributedAt` is the session's MOST RECENT contributing interaction on THIS
 * artifact — not the session's own start or last-activity time. The two diverge
 * routinely (a long-running session that touched the artifact once at the
 * beginning), and ordering the field by session recency instead would present a
 * stale contribution as the newest one.
 */
export type RelatedSessionSummary = {
  /**
   * The Session ARTIFACT id. An opaque route token for the Sessions surface,
   * per the `branchArtifactId` precedent — never parsed or joined on.
   */
  sessionArtifactId: string;
  /** `SES-*` slug, null until one is allocated. */
  slug: string | null;
  name: string | null;
  /**
   * The session's persisted lifecycle status. Typed as `string` rather than
   * `SessionStatus` because this crosses a version-skew boundary and the
   * canonical badge already folds an unrecognized value to an honest "Unknown"
   * rather than fabricating a state. Consumers MUST render it through that
   * fold, never compare it to a literal.
   */
  status: string;
  /**
   * The session's owner, or null — a Session artifact survives its owner's
   * deletion as an org-owned record. Carried as name parts rather than a
   * pre-rendered string so the renderer applies the one canonical
   * `getUserDisplayName` fallback chain instead of this module growing a second
   * one.
   *
   * Deliberately NOT `BasicUser`: that shape carries `email`, and this field
   * renders only a name and an avatar. A provenance list is read by anyone who
   * can see the artifact, so shipping a contributor's address to it would
   * disclose more than the surface shows. `getUserDisplayName` treats `email`
   * as optional, so omitting it costs only the email-as-name fallback — which
   * this surface does not want anyway.
   */
  owner: RelatedSessionOwner | null;
  /** Which evidence made this session related. Always an eligible kind. */
  kind: ProvenanceRelationshipKind;
  /** ISO-8601. */
  contributedAt: string;
};

/**
 * `items` is capped at {@link RELATED_SESSIONS_DISPLAY_CAP}; `total` is how many
 * eligible sessions the reader could actually reach if the cap were lifted.
 *
 * They differ ONLY by the cap. A contribution the producer had to discard —
 * because the org-scoped session projection did not return its session — is
 * subtracted from `total` too, so "+N more" can never point at rows that are
 * not there to be revealed. `total` is a promise about what exists, not a count
 * of edges the producer happened to read (the `linkedArtifactsTotal` precedent
 * on the session row).
 */
export type RelatedSessionsResult = {
  items: RelatedSessionSummary[];
  total: number;
};

/** Maximum artifact ids one page-shaped Related Sessions request may ask for. */
export const RELATED_SESSIONS_PAGE_ARTIFACT_CAP =
  BRANCH_LIST_SERVER_PAGE_SIZE_MAX;

/**
 * How many pills the field shows before it overflows. Server-owned so the
 * renderer never applies a second, different cap — a client-side slice on top
 * of a server slice is how "+N more" comes to report the wrong N.
 */
export const RELATED_SESSIONS_DISPLAY_CAP = 8;

/**
 * The page-shaped batch read (ISS-9570). One owner for the web hook, the
 * desktop bridge allowlist, and their tests: a route move fails typecheck
 * here instead of becoming a silent refusal in the desktop main process.
 */
export const RELATED_SESSIONS_BATCH_ROUTE = "/artifacts/related-sessions";

export type RelatedSessionsBatchRequest = {
  artifactIds: string[];
  /** ISS-12653: match these sessions before applying the pill display cap. */
  sessionArtifactIds?: string[];
  /** Search candidate identities before the pill cap, for collection facets. */
  sessionSearch?: string;
};

/**
 * Batch Related Sessions response for page-shaped consumers.
 *
 * An absent key means the artifact was missing, inaccessible to the org, or an
 * unsupported Session artifact. A present `{ items: [], total: 0 }` means the
 * artifact was resolved and computed, but no eligible sessions were found.
 */
export type RelatedSessionsBatchResponse = {
  results: Record<string, RelatedSessionsResult>;
  /** Echoed only when the server applied the optional session filter. */
  appliedSessionArtifactIds?: string[];
  appliedSessionSearch?: string;
};

/**
 * The non-Session exception, in one place. Related Sessions is inherited by
 * every artifact type EXCEPT Session: a session's relationship to itself is not
 * provenance, and the artifact whose provenance is being described cannot also
 * be an item in its own list.
 *
 * Exhaustive over `ArtifactType` by construction — a fifth type is admitted
 * deliberately here rather than by falling through a default.
 */
export function supportsRelatedSessionsField(type: ArtifactType): boolean {
  return type !== ArtifactType.Session;
}
