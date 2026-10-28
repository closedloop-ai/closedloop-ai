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
};
