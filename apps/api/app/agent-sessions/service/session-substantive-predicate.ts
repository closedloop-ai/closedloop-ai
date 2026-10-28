/**
 * FEA-3284: the SQL-side owner of "this session did something" — the twin of
 * the `isSubstantiveSession` JS SSOT (`@repo/api/src/agent-session-filters`)
 * and the desktop sync twin (`synced-session-substantive.ts`). A session is
 * substantive when it has at least one turn, OR any token was consumed (input
 * + output + cache read + cache write), OR at least one tool was used, OR it
 * produced at least one component invocation (ISS-5801: the column is folded at
 * invocation-generation activation, so a slash-command/skill/subagent/hook-only
 * session classifies as real work).
 *
 * ISS-4752 extracted this out of `query-builder.ts` because the data-invariant
 * audit needs the SAME classification in raw SQL, and a third hand-written
 * copy is how that audit would go quietly stale the next time the definition
 * moves. Both dialects below are built from {@link SESSION_SUBSTANTIVE_SIGNALS}
 * through exhaustive `Record`s, so a signal added to the inventory fails `tsc`
 * until it is spelled in BOTH dialects rather than reaching only one.
 *
 * `turns` is a nullable Int (null = no signal → idle); the token/tool columns
 * are non-null with a 0 default, which is why only `turns` is coalesced on the
 * SQL side. Any edit here MUST still be mirrored in the JS and desktop twins —
 * the FEA-3149 lockstep contract — so a row buckets identically on cloud,
 * desktop, and the shared UI.
 */
import { Prisma } from "@repo/database";

/**
 * The inventory both dialects are built from. Adding a signal here forces
 * every exhaustive `Record` below to name it.
 */
export const SESSION_SUBSTANTIVE_SIGNALS = [
  "turns",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "toolUseCount",
  "componentInvocationCount",
] as const;

export type SessionSubstantiveSignal =
  (typeof SESSION_SUBSTANTIVE_SIGNALS)[number];

/** Table aliases the SQL dialect may be bound to. Closed set, because the
 * alias is interpolated as a raw identifier and so may never be a caller
 * value. */
export const SessionSubstantiveAlias = {
  SessionDetail: "sd",
} as const;

export type SessionSubstantiveAlias =
  (typeof SessionSubstantiveAlias)[keyof typeof SessionSubstantiveAlias];

/**
 * The Prisma dialect, one arm per signal. Spelled out rather than computed
 * from the field name so each arm keeps its literal key type — a computed
 * `{ [signal]: … }` widens to an index signature and stops being checked
 * against the real `SessionDetail` field set.
 */
const PRISMA_ARMS: Record<
  SessionSubstantiveSignal,
  Prisma.SessionDetailWhereInput
> = {
  turns: { turns: { gt: 0 } },
  inputTokens: { inputTokens: { gt: 0 } },
  outputTokens: { outputTokens: { gt: 0 } },
  cacheReadTokens: { cacheReadTokens: { gt: 0 } },
  cacheWriteTokens: { cacheWriteTokens: { gt: 0 } },
  toolUseCount: { toolUseCount: { gt: 0 } },
  componentInvocationCount: { componentInvocationCount: { gt: 0 } },
};

/** Physical column per signal, for the raw-SQL dialect. */
const SIGNAL_COLUMNS: Record<SessionSubstantiveSignal, string> = {
  turns: "turns",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_tokens",
  cacheWriteTokens: "cache_write_tokens",
  toolUseCount: "tool_use_count",
  componentInvocationCount: "component_invocation_count",
};

/**
 * Whether the signal's column is nullable, and so needs coalescing in SQL: a
 * bare `turns > 0` evaluates to SQL NULL for a null-turns row (three-valued
 * logic). The Prisma dialect's `{ gt: 0 }` already excludes null.
 */
const SIGNAL_IS_NULLABLE: Record<SessionSubstantiveSignal, boolean> = {
  turns: true,
  inputTokens: false,
  outputTokens: false,
  cacheReadTokens: false,
  cacheWriteTokens: false,
  toolUseCount: false,
  componentInvocationCount: false,
};

/**
 * ISS-5801: which signals represent work the metering pipeline can PRICE.
 * Component invocations are real work (they make a session substantive) but
 * consume no tokens by themselves, so a metered invocation-only session
 * correctly costs $0 — the zero-cost audit must not page on it. An exhaustive
 * `Record` so the next signal added to the inventory fails `tsc` until someone
 * decides whether the cost audit should count it.
 */
const SIGNAL_IMPLIES_PRICEABLE_WORK: Record<SessionSubstantiveSignal, boolean> =
  {
    turns: true,
    inputTokens: true,
    outputTokens: true,
    cacheReadTokens: true,
    cacheWriteTokens: true,
    toolUseCount: true,
    componentInvocationCount: false,
  };

/**
 * The pre-ISS-5801 signal set, for the zero-cost data-invariant audit: every
 * substantive signal except the unpriceable invocation count, preserving the
 * audit's alerting semantics byte-for-byte.
 */
export const SESSION_PRICEABLE_SIGNALS: readonly SessionSubstantiveSignal[] =
  SESSION_SUBSTANTIVE_SIGNALS.filter(
    (signal) => SIGNAL_IMPLIES_PRICEABLE_WORK[signal]
  );

/** The Prisma dialect. */
export const SESSION_SUBSTANTIVE_WHERE: Prisma.SessionDetailWhereInput = {
  OR: SESSION_SUBSTANTIVE_SIGNALS.map((signal) => PRISMA_ARMS[signal]),
};

/** The Prisma dialect over only the priceable signals (the cost audit's set). */
export const SESSION_PRICEABLE_WHERE: Prisma.SessionDetailWhereInput = {
  OR: SESSION_PRICEABLE_SIGNALS.map((signal) => PRISMA_ARMS[signal]),
};

/**
 * The raw-SQL dialect, for aggregate queries that group in Postgres and so
 * cannot use a Prisma predicate. Emits a parenthesised OR over the same
 * signals, in the same order, as {@link SESSION_SUBSTANTIVE_WHERE}.
 */
export function sessionSubstantiveSql(
  alias: SessionSubstantiveAlias,
  // ISS-5801: the cost audit passes SESSION_PRICEABLE_SIGNALS; everything else
  // takes the full inventory.
  signals: readonly SessionSubstantiveSignal[] = SESSION_SUBSTANTIVE_SIGNALS
): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(
    signals.map((signal) => substantiveSqlArm(alias, signal)),
    " OR "
  )})`;
}

function substantiveSqlArm(
  alias: SessionSubstantiveAlias,
  signal: SessionSubstantiveSignal
): Prisma.Sql {
  const column = Prisma.raw(`${alias}.${SIGNAL_COLUMNS[signal]}`);
  if (SIGNAL_IS_NULLABLE[signal]) {
    return Prisma.sql`COALESCE(${column}, 0) > 0`;
  }
  return Prisma.sql`${column} > 0`;
}

/**
 * ISS-10833: which signals are token usage the source recorded. The zero-cost
 * audit stops paging on an error-ended session only when every one of these is
 * zero, so a signal added to the inventory fails `tsc` until someone decides
 * whether it counts as usage.
 */
const SIGNAL_IS_TOKEN_USAGE: Record<SessionSubstantiveSignal, boolean> = {
  turns: false,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  toolUseCount: false,
  componentInvocationCount: false,
};

/** The token-usage signals, for either dialect. */
export const SESSION_TOKEN_USAGE_SIGNALS: readonly SessionSubstantiveSignal[] =
  SESSION_SUBSTANTIVE_SIGNALS.filter((signal) => SIGNAL_IS_TOKEN_USAGE[signal]);

/** The Prisma dialect over only the token-usage signals: any token recorded. */
export const SESSION_TOKEN_USAGE_WHERE: Prisma.SessionDetailWhereInput = {
  OR: SESSION_TOKEN_USAGE_SIGNALS.map((signal) => PRISMA_ARMS[signal]),
};
