import type { JsonObject } from "./common";

export type Organization = {
  id: string;
  clerkId: string;
  name: string;
  slug: string;
  active: boolean;
  settings: JsonObject;
  /**
   * Privacy gate for unified search over AI session transcript CONTENT
   * (FEA-3930, parent FEA-3800). Default false — transcript text is only indexed
   * into the search projection and returned by the FTS query when an org admin
   * opts in. Both the write-time indexer and the query path check this flag.
   *
   * Optional for deploy skew (ISS-4624): a NEW app can be live against a
   * PREVIOUS API that predates this field, which strips it from both the
   * `GET /organizations/:id` read and the `PUT /organizations/:id` echo. Absent
   * means "this server can't tell us" — NOT `false`. Consumers must render an
   * unavailable state rather than assert a value, and must treat a write whose
   * response omits (or disagrees with) the requested value as not applied. A
   * current API always sends an explicit boolean; it never sends `null`.
   */
  searchIncludeTranscripts?: boolean;
  /**
   * Org-wide privacy gate for local agent-session sync (FEA-4169, ISS-4537).
   * Default false — this org's locally-captured agent-session data (metadata
   * batches, transcripts, trace-comment sync) is only allowed to sync to the
   * ClosedLoop cloud when an org admin opts in. The server fail-closed-enforces
   * the same denial at every ingest boundary (`isOrgSessionSyncPolicyEnabled`);
   * this field exposes the current state so the admin toggle can reflect it.
   *
   * Optional for deploy skew (ISS-4624), on the same terms as
   * `searchIncludeTranscripts` above: absent means "unknown", never `false`.
   * Server-side enforcement does not read this field — it reads the column
   * directly — so an absent field only ever degrades the admin UI to an
   * honest unavailable state, never the fail-closed ingest denial.
   */
  sessionSyncPolicyEnabled?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOrganizationInput = {
  clerkId: string;
  name: string;
  slug: string;
};

export type UpdateOrganizationInput = {
  id: string;
  name?: string;
  slug?: string;
  settings?: JsonObject;
  active?: boolean;
  /** Toggle the transcript-content search gate (FEA-3930). Admin-only. */
  searchIncludeTranscripts?: boolean;
  /** Toggle the org session-sync privacy policy (FEA-4169). Admin-only. */
  sessionSyncPolicyEnabled?: boolean;
};
