/**
 * ISS-9428 keys-covered guard for the Sessions IPC request contract.
 *
 * `sharedAgentSessionsQueryShape` validates the renderer payload at the four
 * `desktop:shared-agent-sessions:*` read channels. `z.object` STRIPS unknown
 * keys — which is deliberate, and is what keeps a version-skewed peer's extra
 * field from sinking the whole read — but it means a field added to
 * `SharedAgentSessionsQuery` that the shape was never taught is silently
 * dropped at the boundary instead of rejected. The in-process callers pass the
 * type directly and skip the schema, so the producer's own tests would never
 * see it.
 *
 * These directives make that a compile error. The guards are anchored on the
 * CANONICAL hand-written types, not on the schemas' inferred output: keying
 * them on the inferred type would be tautological, since that type IS the
 * shape's output and can never disagree with itself.
 *
 * This directory is compiled by `typecheck:type-tests`, so a directive that
 * stops being needed fails the build — which is the point.
 */

import type { z } from "zod";
import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionsQuery,
} from "../src/shared/shared-agent-sessions-contract.js";

type SharedAgentSessionsQueryShape = Record<
  keyof SharedAgentSessionsQuery,
  z.ZodTypeAny
>;
type SharedAgentSessionsListRequestShape = Record<
  keyof SharedAgentSessionsListRequest,
  z.ZodTypeAny
>;

declare const anySchema: z.ZodTypeAny;

// A shape carrying only `search` is not total over `SharedAgentSessionsQuery`.
// If this stops erroring, the guard in `shared-agent-sessions-contract-schema.ts`
// has stopped being total and a newly-modelled filter can be dropped in transit.
// @ts-expect-error - omits every SharedAgentSessionsQuery field except `search`
export const incompleteQueryShape: SharedAgentSessionsQueryShape = {
  search: anySchema,
};

/**
 * Total over the QUERY, which is still not total over the LIST request: `ids`
 * is the field the list and pageData channels narrow on, and it lives only on
 * the wider type. Spelling the guard this way pins the relationship between the
 * two shapes without restating 25 keys.
 */
declare const queryShape: SharedAgentSessionsQueryShape;

// `keyof` includes OPTIONAL members, so the guard fires for `ids` — the case
// most likely to be forgotten, because it is conditionally emitted and is read
// downstream through `Object.hasOwn` rather than through its value.
// @ts-expect-error - omits the optional `ids`
export const listRequestMissingIds: SharedAgentSessionsListRequestShape =
  queryShape;
