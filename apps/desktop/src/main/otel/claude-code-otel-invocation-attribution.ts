/**
 * @file claude-code-otel-invocation-attribution.ts
 * @description ISS-10720: join the component attribution Claude Code stamps on
 * its own OTel cost counters (ISS-7352 item E) onto the invocation rows this
 * device derived from the transcript.
 *
 * ISS-7352 persisted `claude_code_cost_event.{agent_name, skill_name, …}` and
 * nothing read it back, so an invocation row could not say that the harness
 * itself had named the component — every row answered "transcript" whatever the
 * harness stamped.
 *
 * THE JOIN IS COMPONENT-SCOPED, NOT OCCURRENCE-SCOPED, and that is the whole of
 * its honesty. The session half is the same key `session-authoritative-cost.ts`
 * already rolls up on: `claude_code_cost_event.session_id` IS `sessions.id`,
 * which is `agent_component_invocations.session_id`. The component half is the
 * attribution tuple's own name columns — and a counter point carries NO
 * occurrence identifier, so no stored field can say WHICH invocation of that
 * component a point measured. This module therefore never pairs a point to an
 * occurrence, and it counts every tuple it cannot resolve instead of guessing.
 *
 * IT IS A PRECEDENCE JOIN, NOT AN AGREEMENT ONE (tamsinb on #7731). Two things
 * happen, and only the first is corroboration. Where the transcript already
 * derived the component, the matching invocations record
 * `attributionSource = harnessOtel` — the harness and this device agreed, and
 * the row says which source is the authority. Where the transcript MISSED the
 * component entirely, the tuple SEATS an invocation for it
 * (`otel-seeded-invocation-candidate.ts`): the harness overrules a transcript
 * that has nothing to say, and the row that appears exists only because OTel
 * said so and records that. Without the seat there was no row for a
 * disagreement to be recorded on, only a counter in a log line, and ISS-10720
 * AC#3 asks for the row.
 *
 * A SEATED ROW CLAIMS ONLY WHAT THE COUNTER SUPPORTS: the component ran in this
 * session. It anchors to the session, carries no `invokedAt`, and measures
 * nothing. A tuple whose column names more than one possible kind seats
 * nothing at all and stays a counter.
 *
 * ISS-7481 (colliding rows overwrite) is why every count here is a LOWER BOUND
 * and is reported as one: a cost row whose natural key collided with a
 * provably-distinct point was preserved rather than written, so an attribution
 * tuple that only ever rode a dropped point is invisible to this join. That
 * biases `unmatched` DOWN, never `matched` up — a tuple that is not in the
 * table cannot match an invocation — so the matched figure is sound and the
 * unresolved figure is a floor.
 */

import {
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import type { Prisma } from "../database/generated/client.js";
import { ClaudeCodeAttributionSource } from "./claude-code-otel-attribution.js";

/**
 * The stored cost-event columns this join reads. `attribution_source` is
 * ISS-7352 step 3's per-row record of whether the harness named anything at
 * all, and it is read rather than inferred from the name columns: a NULL name
 * cannot distinguish "the harness said nothing" from "this build never looked".
 */
export type OtelCostAttributionRow = {
  attribution_source: string | null;
  agent_name: string | null;
  skill_name: string | null;
  plugin_name: string | null;
  marketplace_name: string | null;
  mcp_server_name: string | null;
  mcp_tool_name: string | null;
  /**
   * Read so the tally can RECONCILE, not to join on. `attributionSourceOf`
   * sets `harness_otel` when ANY identity field is present, and `query_source`
   * is one of them while naming no component at all — so a plain main-loop
   * point is an attributed row that yields no tuple. Counting it beside the
   * component-bearing rows made every counter zero on a report that still
   * fired.
   */
  query_source: string | null;
};

/** The minimum an invocation candidate must expose to take a stamp. */
export type OtelAttributableInvocation = {
  componentKind: string;
  rawName?: string | null;
  normalizedName?: string | null;
  evidenceClass: AgentComponentInvocationEvidenceClass;
  attributionSource: string | null;
};

/**
 * What the join resolved, so the 4-matched-against-32,930-unresolved figure can
 * be re-taken instead of re-estimated.
 *
 * Every counter is incremented INSIDE the branch whose precondition it
 * describes: `matchedAttributions` only after a lookup returned rows,
 * `ambiguousAttributions` only after one returned two different kinds. Counting
 * before the lookup would inflate the signal onto cases it does not describe.
 */
export type OtelInvocationAttributionTally = {
  /** Cost rows read for this session, attributed or not. */
  costEventRows: number;
  /** Rows the harness stamped at least one COMPONENT name on. */
  attributedCostEventRows: number;
  /**
   * Rows the harness attributed on a non-component dimension only —
   * `query_source` names where a query came from, never which component ran.
   * Held apart so `attributedCostEventRows` is exactly the population the
   * tuple counters below are drawn from and the two reconcile.
   */
  nonComponentAttributedRows: number;
  /** Distinct attributed tuples that resolved to exactly one invocation kind. */
  matchedAttributions: number;
  /** Distinct tuples naming one component that two invocation kinds claim. */
  ambiguousAttributions: number;
  /**
   * Distinct tuples naming a component this session has no invocation for AND
   * which this join may not seat one for — today exactly the `skill.name`
   * column, whose one key space covers both a skill and a same-named
   * `/command`, so nothing here can say which of the two ran.
   *
   * ISS-10720 (tamsinb on #7731): before the seat existed this counter also
   * held every unmatched `agent_name` tuple, and those wrote no row at all —
   * which made the whole join an AGREEMENT join, because the only rows it ever
   * touched were ones the transcript had already found. Those now seat a row;
   * what is left here is genuinely undecidable rather than merely unwritten.
   */
  unmatchedAttributions: number;
  /**
   * Distinct tuples that named a component the transcript missed and SEATED an
   * invocation for it — the precedence half of the join. The harness wins the
   * attribution question outright here: the row exists only because it said so,
   * and it records `attributionSource = harnessOtel` to say which source did.
   */
  seatedInvocations: number;
  /**
   * Distinct tuples whose only names are dimensions no invocation kind can
   * carry evidence for — `mcp_server.name` / `mcp_tool.name` land on kinds the
   * wire boundary pins to `none` (`non_definition_kind_has_provenance_evidence`)
   * and `plugin.name` has no invocation kind at all. Counted rather than
   * dropped: they are attribution the harness supplied and this build cannot
   * yet seat, which is a different fact from an unmatched name.
   */
  unjoinableAttributions: number;
  /** Invocation rows this pass recorded an OTel attribution source on. */
  stampedInvocations: number;
};

/**
 * The OTel name column that names each joinable invocation kind.
 *
 * `skill.name` names BOTH a skill and a slash command: the harness stamps one
 * key space for the two (the same one `component-usage-attribution.ts` strips a
 * leading slash to enter), so a tuple naming `foo` where the session ran both a
 * `foo` skill and a `/foo` command names two different components and is
 * refused as ambiguous rather than charged to either.
 */
const JOINABLE_KIND_COLUMNS = [
  {
    column: "agent_name",
    kinds: [AgentComponentInvocationKind.Subagent],
  },
  {
    column: "skill_name",
    kinds: [
      AgentComponentInvocationKind.Skill,
      AgentComponentInvocationKind.Command,
    ],
  },
] as const satisfies readonly {
  column: keyof OtelCostAttributionRow;
  kinds: readonly AgentComponentInvocationKind[];
}[];

/** Name columns that carry attribution no invocation row may take evidence from. */
const UNJOINABLE_NAME_COLUMNS = [
  "plugin_name",
  "marketplace_name",
  "mcp_server_name",
  "mcp_tool_name",
] as const satisfies readonly (keyof OtelCostAttributionRow)[];

/** Every column this join reads a COMPONENT name out of. */
const COMPONENT_NAME_COLUMNS: readonly (keyof OtelCostAttributionRow)[] = [
  ...JOINABLE_KIND_COLUMNS.map((entry) => entry.column),
  ...UNJOINABLE_NAME_COLUMNS,
];

/** True when the harness named a component — not merely a query source — here. */
function namesAComponent(row: OtelCostAttributionRow): boolean {
  return COMPONENT_NAME_COLUMNS.some(
    (column) => storedName(row[column]) !== undefined
  );
}

/** True when the harness attributed the row at all. */
function isHarnessAttributed(row: OtelCostAttributionRow): boolean {
  return row.attribution_source === ClaudeCodeAttributionSource.HarnessOtel;
}

/**
 * Fold a component name to the form both sides of THIS join are compared in.
 *
 * The leading slash is stripped for the reason `attributionKey`
 * (`packages/lib/harness/claude/component-usage-attribution.ts`) strips it: a
 * `/foo` command entry has to compare equal to the `foo` the harness stamps for
 * it, which never carries one.
 *
 * THE TRIM AND THE CASE-FOLD ARE THIS JOIN'S OWN, AND ARE DELIBERATELY WIDER
 * than that helper, which does the slash strip and nothing else (tamsinb on
 * #7731). The two are not a parity pair and must not be described as one: a
 * skill stored as `Deploy` against a `deploy` stamp misses over there and
 * matches here, which is the better answer on this side because the OTel
 * counter carries a harness-authored name rather than a key this device minted.
 * `applyOtelInvocationAttribution`'s `agent_name: "Alpha"` case pins the fold as
 * intended rather than incidental.
 *
 * TRIM RUNS FIRST so a stored `" /deploy"` reaches the slash strip instead of
 * folding to `/deploy` and matching nothing.
 */
function foldAttributionName(value: string): string {
  const trimmed = value.trim();
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return withoutSlash.toLowerCase();
}

/** A non-blank stored name, or `undefined` — a blank cell names nothing. */
function storedName(value: string | null): string | undefined {
  if (value === null) {
    return;
  }
  const folded = foldAttributionName(value);
  return folded.length > 0 ? folded : undefined;
}

/**
 * Index this session's invocations by folded name, carrying the set of kinds
 * that name resolves to so a cross-kind collision is detectable.
 *
 * A `Map` rather than an object literal because the keys are untrusted harness
 * names, which on a plain `{}` would reach `__proto__` and `constructor`.
 */
function indexInvocationsByName<T extends OtelAttributableInvocation>(
  invocations: readonly T[]
): Map<string, Map<string, T[]>> {
  const byName = new Map<string, Map<string, T[]>>();
  for (const invocation of invocations) {
    const name = storedName(
      invocation.normalizedName ?? invocation.rawName ?? null
    );
    if (name === undefined) {
      continue;
    }
    const byKind = byName.get(name) ?? new Map<string, T[]>();
    const bucket = byKind.get(invocation.componentKind) ?? [];
    bucket.push(invocation);
    byKind.set(invocation.componentKind, bucket);
    byName.set(name, byKind);
  }
  return byName;
}

/** The distinct (column, folded name) pairs the harness stamped this session. */
function distinctAttributions(
  rows: readonly OtelCostAttributionRow[]
): Map<string, { column: keyof OtelCostAttributionRow; name: string }> {
  const seen = new Map<
    string,
    { column: keyof OtelCostAttributionRow; name: string }
  >();
  for (const row of rows) {
    if (!isHarnessAttributed(row)) {
      continue;
    }
    for (const column of COMPONENT_NAME_COLUMNS) {
      const name = storedName(row[column]);
      if (name !== undefined) {
        // `column` is drawn from the two fixed lists above and contains no
        // colon, so this pair key is injective over (column, name).
        seen.set(`${column}:${name}`, { column, name });
      }
    }
  }
  return seen;
}

/**
 * How an unmatched tuple becomes a row: the caller supplies the invocation this
 * join may seat for a component the transcript missed.
 *
 * Injected rather than constructed here so this module stays free of the
 * desktop candidate shape, and so a test can drive the precedence branch with a
 * minimal invocation. `undefined` means "this build declines to seat that
 * kind", which is not the same as "the tuple matched nothing" and is counted
 * apart from it.
 */
export type OtelInvocationSeat<T> = (input: {
  componentKind: string;
  name: string;
}) => T | undefined;

/**
 * Seat a row for a tuple that named a component this session has no invocation
 * for, or `undefined` when nothing may be seated for it.
 *
 * A column whose OTel name maps to MORE THAN ONE invocation kind is refused
 * outright: `skill.name` covers both a skill and a same-named `/command`, so a
 * tuple that matched neither cannot say which one ran, and a seat would be a
 * guess wearing an evidence class. That refusal is the tuple's own property, so
 * it is decided here rather than left to each caller's factory.
 */
function seatMissingComponent<T extends OtelAttributableInvocation>(
  seat: OtelInvocationSeat<T> | undefined,
  joinable: (typeof JOINABLE_KIND_COLUMNS)[number],
  name: string,
  tally: OtelInvocationAttributionTally
): T | undefined {
  if (seat === undefined || joinable.kinds.length !== 1) {
    return;
  }
  const seated = seat({ componentKind: joinable.kinds[0], name });
  if (seated === undefined) {
    return;
  }
  tally.seatedInvocations += 1;
  return seated;
}

/**
 * ISS-10720: record the harness's own attribution on every invocation its
 * counters named, and return what did and did not resolve.
 *
 * PRECEDENCE IS OTel-WINS ON THE ATTRIBUTION QUESTION, which is ISS-7352's own
 * recorded ruling rather than a new one: "Harness-stamped attribution wins
 * wherever it exists" (`attributionSourceOf`,
 * `claude-code-otel-attribution.ts`). The harness names the component it ran;
 * this device RECONSTRUCTS that name from a transcript. So where the two
 * disagree the row records `attributionSource = harnessOtel` and the reader can
 * see which source won — and where the transcript produced no row to record it
 * on, `seat` mints one, which is the case that makes this precedence rather
 * than corroboration.
 *
 * IT WINS ITS OWN AXIS AND ONLY ITS OWN. `attributionSource` answers WHO
 * attributed the row; `evidenceClass` answers where the DEFINITION came from,
 * and `genuineSourceOccurrence`
 * (`apps/api/app/agent-sessions/service/component-invocation-helpers.ts`) reads
 * that one to build the component-detail surface's on-disk source pointer. The
 * first cut of this change wrote the attribution answer into `evidenceClass`
 * and silently deleted that pointer on every joined row — a capability nobody
 * would have filed a bug about, because a pointer that is no longer rendered
 * leaves no trace. No operand was ever missing: the `sourcePath`, the
 * definition provenance and the harness's attribution are all present, and one
 * column was simply carrying two jobs that disagree.
 *
 * `evidenceClass` therefore moves ONLY from `none` — where there is no
 * definition evidence to displace, so recording `otelCounter` costs nothing and
 * the enum member the ticket asks for is genuinely emitted. A row that already
 * holds transcript, collector, repository or pack evidence keeps it, and
 * records the harness's attribution beside it.
 */
export function applyOtelInvocationAttribution<
  T extends OtelAttributableInvocation,
>(
  invocations: T[],
  costRows: readonly OtelCostAttributionRow[],
  seat?: OtelInvocationSeat<T>
): OtelInvocationAttributionTally {
  const tally: OtelInvocationAttributionTally = {
    costEventRows: costRows.length,
    attributedCostEventRows: costRows.filter(
      (row) => isHarnessAttributed(row) && namesAComponent(row)
    ).length,
    nonComponentAttributedRows: costRows.filter(
      (row) => isHarnessAttributed(row) && !namesAComponent(row)
    ).length,
    matchedAttributions: 0,
    ambiguousAttributions: 0,
    unmatchedAttributions: 0,
    seatedInvocations: 0,
    unjoinableAttributions: 0,
    stampedInvocations: 0,
  };
  const attributions = distinctAttributions(costRows);
  if (attributions.size === 0) {
    return tally;
  }
  const byName = indexInvocationsByName(invocations);
  const stamped = new Set<T>();
  for (const { column, name } of attributions.values()) {
    const joinable = JOINABLE_KIND_COLUMNS.find(
      (entry) => entry.column === column
    );
    if (!joinable) {
      tally.unjoinableAttributions += 1;
      continue;
    }
    const byKind = byName.get(name);
    const matchedKinds = joinable.kinds.filter((kind) => byKind?.has(kind));
    if (matchedKinds.length === 0) {
      const seated = seatMissingComponent(seat, joinable, name, tally);
      if (seated === undefined) {
        tally.unmatchedAttributions += 1;
        continue;
      }
      invocations.push(seated);
      stamped.add(seated);
      continue;
    }
    if (matchedKinds.length > 1) {
      tally.ambiguousAttributions += 1;
      continue;
    }
    tally.matchedAttributions += 1;
    for (const invocation of byKind?.get(matchedKinds[0]) ?? []) {
      invocation.attributionSource =
        AgentComponentInvocationAttributionSource.HarnessOtel;
      if (
        invocation.evidenceClass === AgentComponentInvocationEvidenceClass.None
      ) {
        invocation.evidenceClass =
          AgentComponentInvocationEvidenceClass.OtelCounter;
      }
      stamped.add(invocation);
    }
  }
  tally.stampedInvocations = stamped.size;
  return tally;
}

/**
 * The one-line report of a pass that saw harness attribution, or `undefined`
 * when it had nothing to say.
 *
 * Bounded to one line per session and silent when the session captured no
 * attributed counters — OTel capture is gated on a Labs setting and reaches a
 * minority of sessions, so a line per session would drown the signal. A pass
 * that DID see attribution always reports, including one that resolved none of
 * it: that case is the 32,930 half of the figure and is the reason the counters
 * exist.
 */
export function otelInvocationAttributionReport(
  sessionId: string,
  tally: OtelInvocationAttributionTally
): string | undefined {
  if (tally.attributedCostEventRows === 0) {
    return;
  }
  return `otel_invocation_attribution ${sessionId}: stamped ${tally.stampedInvocations} invocation(s) from ${tally.matchedAttributions} matched attribution(s); seated=${tally.seatedInvocations} unmatched=${tally.unmatchedAttributions} ambiguous=${tally.ambiguousAttributions} unjoinable=${tally.unjoinableAttributions} over ${tally.attributedCostEventRows}/${tally.costEventRows} component-attributed cost row(s), ${tally.nonComponentAttributedRows} attributed on query_source alone (ISS-7481: collided rows are preserved rather than stored, so these are lower bounds)`;
}

/**
 * Read this session's captured cost-event attribution and stamp it onto the
 * candidates, reporting what did not resolve.
 *
 * Rides the CALLER'S transaction, so the stamp commits with the rows it is
 * applied to and a crash between the two cannot leave an invocation claiming
 * evidence from counters nobody stored. Runs on the candidates before they are
 * inserted rather than as a follow-up UPDATE, so the generation hash the
 * caller computes afterwards already includes the class and the change reaches
 * the cloud through the ordinary `invocationSetChanged` path.
 *
 * Reads the whole session's cost rows once rather than one lookup per
 * candidate — `idx_claude_code_cost_event_session` covers the predicate, and a
 * per-candidate probe would make an aggregate pay a row projection.
 */
export async function stampOtelInvocationAttribution<
  T extends OtelAttributableInvocation,
>(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  sessionId: string,
  invocations: T[],
  log: (message: string) => void,
  seat?: OtelInvocationSeat<T>
): Promise<OtelInvocationAttributionTally> {
  const rows = await tx.$queryRawUnsafe<OtelCostAttributionRow[]>(
    `SELECT attribution_source, agent_name, skill_name, plugin_name,
            marketplace_name, mcp_server_name, mcp_tool_name, query_source
       FROM claude_code_cost_event
      WHERE session_id = $1`,
    sessionId
  );
  const tally = applyOtelInvocationAttribution(invocations, rows, seat);
  const report = otelInvocationAttributionReport(sessionId, tally);
  if (report) {
    log(report);
  }
  return tally;
}
