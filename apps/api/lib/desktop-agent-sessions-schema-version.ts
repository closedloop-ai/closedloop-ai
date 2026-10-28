/**
 * @file ISS-6886 — the Zod validator for a desktop → cloud batch's
 * `schemaVersion`, and the one place that decides which wire versions the cloud
 * ingest boundary admits.
 *
 * A sibling of `desktop-agent-sessions-schema.ts` rather than another block
 * inside it: which installed clients can still sync is a self-contained
 * cross-repo compatibility decision with its own rationale and its own reason
 * to change (a version bump), while that module's job is the SHAPE of a batch's
 * sessions, events, and metrics. Keeping them apart also keeps the decision
 * findable — the next bump is the moment the FEA-2718 mistake repeats, and it
 * should land in a file whose whole subject is that choice.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION_V1,
  AGENT_SESSION_SYNC_SCHEMA_VERSION_V2,
} from "@repo/api/src/types/agent-session-sync-schema-version";
import { z } from "zod";

/**
 * ISS-6886: accept the previous batch version alongside the current one.
 *
 * A single `z.literal(2)` here made every already-installed v1 desktop unable to
 * sync at all — the repository's cross-repo contract forbids requiring a
 * lockstep upgrade of installed clients. v1's only wire difference is the
 * turn-text `summary`/`data` on each event, which the non-strict event
 * `z.object` in `desktop-agent-sessions-schema.ts` already strips before any DB
 * write, so a v1 batch maps onto the v2 columnar shape with nothing invented and
 * nothing persisted that v2 would not persist.
 *
 * A version outside this union still fails closed and is summarized as
 * `schema_version_invalid`. The union is spelled out as literals, not derived
 * from `ACCEPTED_AGENT_SESSION_SYNC_SCHEMA_VERSIONS`, so the inferred type stays
 * a union of literals for `assertAcceptedSchemaVersionsAgree` in
 * `desktop-agent-sessions-schema-guards.ts` to check the two sides against each
 * other — that guard is what fails `tsc` if this set and the contract tuple ever
 * disagree.
 */
export const acceptedBatchSchemaVersionSchema = z.union([
  z.literal(AGENT_SESSION_SYNC_SCHEMA_VERSION_V1),
  z.literal(AGENT_SESSION_SYNC_SCHEMA_VERSION_V2),
]);
