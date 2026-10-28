/**
 * @file shared-agent-sessions-contract-schema.ts
 * @description ISS-9428: the Zod shape for the `desktop:shared-agent-sessions:*`
 * IPC REQUEST, beside the hand-written {@link SharedAgentSessionsQuery} it
 * validates. Split from the contract module (values/parsers split) so a
 * bundle-sensitive client can keep importing the channel constants and the
 * boundary type without pulling Zod in behind them.
 *
 * Before this, all four read handlers took their renderer payload through
 * `coerceSharedQuery`, whose whole body is a `typeof value === "object"` test and
 * an `as Record<string, unknown>` cast. A cast is not validation: every field
 * reaching `sanitizeQuery` was `unknown` wearing a type, and the per-field
 * `typeof` checks there are exactly the hand-rolled shape AGENTS.md says to
 * replace with Zod.
 *
 * Two properties of this schema are load-bearing and neither is incidental:
 *
 * **Unknown keys are STRIPPED, not rejected.** Deliberately NOT `.strict()`,
 * for the reason already written out over `diagnosticsRequestSchema` in
 * `agent-dashboard-ipc-coercion.ts` and generalized by the repo's
 * `.strict()`-boundary lesson: a strict schema rejects the WHOLE payload when it
 * meets one field it was not taught, so an unrelated additive field silently
 * turns a working read into an empty one. That is not hypothetical here. The
 * renderer forwards the shared `AgentSessionQueryFilters` to this contract
 * VERBATIM (`local-agent-sessions-data-source.ts`), and that client type already
 * carries three fields this contract does not model — `viewerScope`,
 * `projectIds`, and (on the usage shape) `comparison`. None reaches these
 * channels from a desktop host today, but `desktop-browser-bridge.ts` projects
 * all four of them onto a browser surface, which is a genuinely version-skewed
 * peer: a newer `apps/app` bundle can send a web-shaped filter set into an older
 * installed Desktop main. Stripping degrades that to "the field is ignored",
 * which is what main already does with it; `.strict()` would degrade it to "the
 * Sessions list is empty".
 *
 * **A malformed MODELLED field degrades to absent, it does not throw.** Every
 * field is `.catch(undefined)`, so this schema cannot change the boundary's
 * established failure semantics. The desktop request boundary fails OPEN and
 * clamps — `clampLimit`/`clampOffset` floor and ceiling out-of-range pagination,
 * `coerceSessionQuality` resolves an unrecognized quality to `all`,
 * `coerceStringArray` turns a non-array into `[]` — and the only thing that
 * throws today is an unparseable date. Hard-rejecting a bad `limit` here would
 * flip desktop from clamp to reject, which is the cloud route's contract, not
 * this one's. The clamps stay the authority on RANGE; this schema is the
 * authority on SHAPE.
 *
 * For an ARRAY field that degradation is PER ENTRY, not wholesale: a mixed
 * array keeps its valid entries and drops the rest, exactly as
 * `coerceStringArray`/`sanitizeIds` already fold it. See
 * {@link optionalStringArray} — rejecting the whole array instead would widen a
 * `userIds` read past the scope it asked for and blank an `ids` read down to
 * nothing, which is the one way this schema could have changed an answer.
 */

import { SESSION_QUALITY_VALUES } from "@repo/api/src/agent-session-filters";
import type { ListQueryExpression } from "@repo/api/src/types/list-query-expression";
import { z } from "zod";
import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionsQuery,
} from "./shared-agent-sessions-contract.js";

const optionalString = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);
const optionalBoolean = z.boolean().optional().catch(undefined);

/**
 * A facet array, filtered PER ENTRY — never rejected whole.
 *
 * `z.array(z.string())` fails at the ARRAY, so one bad entry sends the whole
 * value through `.catch(undefined)` and the facet disappears. That is not what
 * this boundary did before, and for these two fields it is the dangerous
 * direction of wrong:
 *
 * - `userIds: ["user-alex", 7]` would lose the Owner facet entirely, and a
 *   dropped owner facet WIDENS the read — `resolveUserScope` sees an empty
 *   `userIds`, applies no `in` constraint, and the list answers with every
 *   owner's sessions under a scope the caller asked to narrow.
 * - `ids: ["session-1", 7]` would become an explicit EMPTY selection, because
 *   `explicitIdsFromRequest` keys on `Object.hasOwn` and a present-but-
 *   `undefined` `ids` is its "narrow to nothing" branch. One bad entry would
 *   blank a list the caller asked to narrow to two rows.
 *
 * `coerceStringArray`/`sanitizeIds` downstream already fold exactly this way —
 * they drop a non-string entry and keep the rest — so filtering here leaves the
 * boundary's established meaning intact instead of inventing a new one. A
 * NON-array still degrades to absent through `.catch(undefined)`, which is the
 * shape `coerceStringArray` also answers with `[]`.
 */
const optionalStringArray = z
  .array(z.unknown())
  .transform((entries) =>
    entries.filter((entry): entry is string => typeof entry === "string")
  )
  .optional()
  .catch(undefined);

/**
 * The per-field shape, `satisfies`-guarded against the boundary type.
 *
 * `satisfies Record<keyof SharedAgentSessionsQuery, z.ZodTypeAny>` is the
 * compile-time keys-covered guard, and it is what a `z.ZodType<T>` annotation
 * alone does NOT give: `ZodType` is covariant in its output, so a schema that
 * simply omits an optional key still satisfies that annotation. `Record<keyof T,
 * …>` requires every key to be present, so the next field added to
 * `SharedAgentSessionsQuery` fails `tsc` HERE — at the boundary that would
 * otherwise have quietly started dropping it — instead of in production.
 */
export const sharedAgentSessionsQueryShape = {
  componentSlug: z.string().min(1).max(4096).optional(),
  startDate: optionalString,
  endDate: optionalString,
  completedAfter: optionalString,
  harness: optionalString,
  status: optionalString,
  search: optionalString,
  userId: optionalString,
  teamId: optionalString,
  projectId: optionalString,
  statuses: optionalStringArray,
  userIds: optionalStringArray,
  repositories: optionalStringArray,
  harnesses: optionalStringArray,
  models: optionalStringArray,
  autonomyTiers: optionalStringArray,
  costBuckets: optionalStringArray,
  changePresence: optionalStringArray,
  prAssociation: optionalStringArray,
  // ISS-10332: passed through like `sorts` below, for the same reason. A priority
  // selection is a closed vocabulary that `sanitizeQuery` REFUSES outside of,
  // because dropping a bad entry — or the whole facet — widens the read to every
  // row while the toolbar still reports the selection.
  priorities: z.custom<readonly string[]>(),
  quality: z.enum(SESSION_QUALITY_VALUES).optional().catch(undefined),
  countOnly: optionalBoolean,
  // Range is NOT bounded here. `clampLimit`/`clampOffset` own it, and the
  // desktop boundary clamps where the cloud route rejects; bounding both would
  // make a 10,000-row request an error on one surface and a 100-row read on the
  // other for the same renderer call.
  limit: optionalNumber,
  offset: optionalNumber,
  sortBy: optionalString,
  sortDir: z.enum(["asc", "desc"]).optional().catch(undefined),
  // `sorts` is the ONE field that must reach `sanitizeQuery` exactly as it
  // arrived, so it is passed through rather than validated.
  //
  // `parseSortRules` owns this field, and its ownership is a REFUSAL, not a
  // coercion: a non-array throws (`sorts is not a list…`), so does a non-string
  // entry, an unreadable rule, a direction that is not asc/desc, a column this
  // source cannot order by, and a second rule. Its docstring says why — "a rule
  // the caller meant and this source cannot read is refused, whatever shape the
  // unreadability takes" — and explicitly rejects dropping one as "the same
  // silent-drop under a different spelling".
  //
  // `.catch(undefined)` here would be exactly that silent drop. Every refusal
  // above would become `undefined`, `sortRuleEntries` would read that as "no
  // rules", and the list would be served in DEFAULT order while the toolbar
  // reported the order the user asked for. Validating this field at the
  // boundary does not add safety; it destroys a deliberate error path.
  sorts: z.custom<readonly string[]>(),
  // ISS-9479: lowered into the params above, and removed, by
  // `compileSessionListQueryRequest` before this schema runs. Passed through
  // like `sorts` so a request that skipped that step reaches `sanitizeQuery`
  // still carrying it and is refused there, rather than stripped here and
  // answered with every row.
  listQuery: z.custom<ListQueryExpression>(),
} satisfies Record<keyof SharedAgentSessionsQuery, z.ZodTypeAny>;

export const sharedAgentSessionsQuerySchema = z.object(
  sharedAgentSessionsQueryShape
);

/**
 * The list/page-data request: the query plus the `ids` narrowing those two
 * channels accept. Same keys-covered guard against the list type, so an
 * additive list-only field cannot be modelled on one channel and forgotten on
 * the other.
 */
export const sharedAgentSessionsListRequestShape = {
  ...sharedAgentSessionsQueryShape,
  ids: optionalStringArray,
} satisfies Record<keyof SharedAgentSessionsListRequest, z.ZodTypeAny>;

export const sharedAgentSessionsListRequestSchema = z.object(
  sharedAgentSessionsListRequestShape
);
