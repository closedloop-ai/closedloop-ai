import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { z } from "zod";

/**
 * Every status an artifact row may carry, across both lifecycle vocabularies.
 *
 * Here rather than in a feature's validator module because two route families
 * read it — the documents write bodies and `GET /artifacts/assigned-tree` —
 * and a second inventory would accept a different set than the writes allow.
 *
 * Membership alone, deliberately: which statuses are legal for a GIVEN artifact
 * is decided against its type/subtype, in the create validator where the type
 * is in the body and in the service for update/batch after the target is loaded.
 */
export const anyArtifactStatusEnum = z.enum({
  ...DocumentStatus,
  ...IssueStatus,
});

/**
 * Accepted element count for a repeated `?status=` param (ISS-6778), DERIVED so
 * adding a lifecycle status cannot leave a hand-typed cap behind. Bounds parse
 * work on a repetitive query string; it is not a second correctness gate.
 */
export const ANY_ARTIFACT_STATUS_COUNT = anyArtifactStatusEnum.options.length;
