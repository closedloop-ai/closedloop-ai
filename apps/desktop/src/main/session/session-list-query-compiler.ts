/**
 * @file session-list-query-compiler.ts
 * @description ISS-9479 (PRD-706 R10-S04): the desktop compiler for the
 * canonical list query expression (ISS-9476, PRD-721).
 *
 * A Sessions IPC request carrying `listQuery` is parsed at the trust boundary
 * by the strict ISS-9476 schema (`parseListQueryExpressionValue`), resolved
 * against `DESKTOP_SESSION_LIST_QUERY_CAPABILITY`, and lowered through the
 * same `lowerSessionListQueryExpression` the cloud route runs, into the legacy
 * `SharedAgentSessionsQuery` params this read already serves. It writes no
 * SQL: the local read's SQL tiers bind every lowered value as a parameter, and
 * every read behind one request (list, usage, analytics, page data and its
 * facet-scoped counts) sees one request shape.
 */
import {
  LIST_QUERY_EXPRESSION_PARAM,
  type ListQueryRefused,
} from "@repo/api/src/types/list-query-expression";
import { parseListQueryExpressionValue } from "@repo/api/src/types/list-query-expression-schema";
import { isListQueryAxisParam } from "@repo/api/src/types/list-query-legacy-params";
import { malformed } from "@repo/api/src/types/list-query-lowering";
import { DESKTOP_SESSION_LIST_QUERY_CAPABILITY } from "@repo/api/src/types/session-list-query-capabilities";
import {
  lowerSessionListQueryExpression,
  type SessionListLoweringTarget,
} from "@repo/api/src/types/session-list-query-lowering";
import {
  SESSION_LIST_FIELD_BY_LEGACY_PARAM,
  SESSION_LIST_QUERY_VOCABULARY,
} from "@repo/api/src/types/session-list-query-registry";
import { z } from "zod";
import type { SharedAgentSessionsQuery } from "../../shared/shared-agent-sessions-contract.js";
import { sharedAgentSessionsQueryShape } from "../../shared/shared-agent-sessions-contract-schema.js";
import { SharedAgentSessionsInputError } from "./shared-agent-sessions-query.js";

/**
 * A `listQuery` this host refused, carrying the ISS-9476 refusal. The message
 * spells the code the way the cloud route's refusal issue does, because only
 * the message survives the IPC bridge.
 */
export class SessionListQueryRefusedError extends SharedAgentSessionsInputError {
  readonly refused: ListQueryRefused;

  constructor(refused: ListQueryRefused) {
    super(`list query refused (${refused.code})`);
    this.name = "SessionListQueryRefusedError";
    this.refused = refused;
  }
}

/**
 * `value` with its `listQuery` lowered into the legacy params, or `value`
 * untouched when it carries none, which is every request a renderer older
 * than ISS-9479 sends. Throws {@link SessionListQueryRefusedError} for an
 * expression this host cannot serve: dropping it would answer with every row.
 *
 * Runs on the raw IPC payload, before `sharedAgentSessionsQuerySchema`, so the
 * lowered values meet the same per-field schema a legacy request meets.
 */
export function compileSessionListQueryRequest(value: unknown): unknown {
  const request = requestRecordSchema.safeParse(value);
  if (
    !request.success ||
    request.data[LIST_QUERY_EXPRESSION_PARAM] === undefined
  ) {
    return value;
  }
  const { [LIST_QUERY_EXPRESSION_PARAM]: listQuery, ...rest } = request.data;
  const mixed = Object.keys(rest).find(
    (name) => rest[name] !== undefined && isExpressionAxisParam(name)
  );
  if (mixed !== undefined) {
    const field = SESSION_LIST_FIELD_BY_LEGACY_PARAM.get(mixed);
    throw new SessionListQueryRefusedError(
      malformed(field === undefined ? {} : { field })
    );
  }
  const parsed = parseListQueryExpressionValue(listQuery);
  if (!parsed.ok) {
    throw new SessionListQueryRefusedError(parsed.refused);
  }
  const lowered = lowerSessionListQueryExpression(
    parsed.expression,
    DESKTOP_SESSION_LIST_QUERY_CAPABILITY,
    DESKTOP_LOWERING_TARGET
  );
  if (!lowered.ok) {
    throw new SessionListQueryRefusedError(lowered.refused);
  }
  return { ...rest, ...lowered.params };
}

const requestRecordSchema = z.record(z.string(), z.unknown());

/**
 * A legacy spelling of an axis the expression speaks, or of its sort. The
 * companion params travel beside the expression on both hosts, and
 * `sanitizeQuery` intersects a scoped `userId` with the expression's User
 * clause (FEA-4304) so the clause can only narrow the scoped user. A desktop
 * read hint the registry does not name (`countOnly`, `ids`) is not a list
 * param and travels too. A key sent as `undefined` is treated as absent.
 */
function isExpressionAxisParam(name: string): boolean {
  return isListQueryAxisParam(name, SESSION_LIST_QUERY_VOCABULARY);
}

/** The `SharedAgentSessionsQuery` keys typed as a list. */
type RepeatableQueryParam = {
  [K in keyof SharedAgentSessionsQuery]-?: NonNullable<
    SharedAgentSessionsQuery[K]
  > extends readonly string[]
    ? K
    : never;
}[keyof SharedAgentSessionsQuery];

/**
 * Exhaustive both ways by type: a list key missing here, or a scalar key
 * listed, fails `tsc`.
 */
const REPEATABLE_QUERY_PARAMS: Readonly<Record<RepeatableQueryParam, true>> = {
  statuses: true,
  userIds: true,
  repositories: true,
  harnesses: true,
  models: true,
  autonomyTiers: true,
  costBuckets: true,
  changePresence: true,
  prAssociation: true,
  priorities: true,
  sorts: true,
};

/** What the IPC request schema takes, so a clause lowers only to a key it reads. */
const DESKTOP_LOWERING_TARGET: SessionListLoweringTarget = {
  acceptedParams: new Set(Object.keys(sharedAgentSessionsQueryShape)),
  repeatableParams: new Set(Object.keys(REPEATABLE_QUERY_PARAMS)),
};
