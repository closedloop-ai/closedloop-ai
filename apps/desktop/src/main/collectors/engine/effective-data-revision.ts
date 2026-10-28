/**
 * ISS-12552 (PRD-800 "Rollout"): the data revision this process stamps,
 * derived from its current parse policy. Every reader that used to import
 * `DATA_REVISION` reads this instead. Nothing branches on a stored revision
 * (ISS-9283): the revision only selects rows whose stamp differs.
 */
import { effectiveParsePolicy } from "../../parse-policy/effective-parse-policy.js";
import { dataRevisionFor } from "./data-revision.js";

export function effectiveDataRevision(): number {
  return dataRevisionFor(effectiveParsePolicy());
}
