/**
 * ISS-4499 Layer 1 fact machinery — split from golden-corpus.ts (file-size
 * ceiling) so the runner keeps discovery/parse/normalize/registration and this
 * module owns the expectations types, the fact builders, and the per-fact
 * check with its divergence bookkeeping.
 *
 * ISS-4499 also extends the oracle surface: session classification
 * (entrypoint / permission_mode / ended_on_unrecovered_error), tool-result
 * shapes, parse-quality counters, the FEA-3419 cache-write TTL split, and the
 * jsonNormalize-stripped usageExtras — each an independently derived
 * expectations.yaml fact so collector drift on these fields turns a golden
 * test red. New blocks are Zod-validated (`.strict()`) at corpus-load time so
 * a typo'd key inside a new block fails loudly instead of silently disabling
 * its assertion; legacy keys outside the new blocks stay unvalidated.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  deriveEndedOnUnrecoveredError,
  Harness,
  type NormalizedSession,
} from "../../src/main/collectors/types.js";
import { findDivergence } from "./golden-divergences.js";

type CacheWriteTtlExpectation = {
  five_m: number;
  one_h: number;
};

type DossierTokenCounts = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  /** FEA-3419 TTL split — claude dossiers with cache_write > 0 must carry it. */
  cache_write_ttl?: CacheWriteTtlExpectation;
};

type DossierSubagent = {
  subagent_id?: string;
  /** ISS-4702: spawn-declared agent type — the raw `.meta.json` `agentType`. */
  agent_type?: string;
  /** ISS-4702: spawn-declared description — the raw `.meta.json` `description`. */
  description?: string;
  model?: string | null;
  tokens?: DossierTokenCounts;
};

type DossierToolResultByTool = {
  name?: string;
  with_output?: number;
  errors?: number;
};

/** The Layer-1-relevant slice of expectations.yaml (extra keys are ignored). */
export type DossierExpectations = {
  /** Top-level `harness:` key — present in every dossier; the Layer 2 runner
   * validates it against the closed union at load time (FEA-2647). */
  harness?: Harness;
  session?: {
    status?: string;
    billing_mode?: string;
    primary_model?: string | null;
    models_used?: string[];
    lifecycle?: {
      fresh?: boolean;
      resumed?: boolean;
      forked?: boolean;
      compacted?: boolean;
      interrupted?: boolean;
    };
    /** ISS-4499: NormalizedSession.entrypoint. */
    entrypoint?: string;
    /** ISS-4499: NormalizedSession.permissionMode (null for codex). */
    permission_mode?: string | null;
    /** ISS-4499: worker-parity failed-run signal (full OR-formula). */
    ended_on_unrecovered_error?: boolean;
  };
  turns?: {
    total?: number;
    user?: number;
    assistant?: number;
    tool_result?: number;
  };
  tokens_by_model?: Record<string, DossierTokenCounts>;
  cost?: { total?: number; metered_total?: number };
  subagents?: { count?: number; attributed?: DossierSubagent[] };
  // Layer-1 activity facts live at two shapes depending on schema_version:
  //   v1 → top-level activity.{tools,commands,thinking_blocks}
  //   v2 (FEA-2642) → per-agent activity.orchestrator.{tools,commands,thinking_blocks}
  //       (+ per-tool `kind`, first-class `skills`). The runner reads whichever
  //       is present via resolveOrchestratorActivity(); both carry the same
  //       Layer-1 orchestrator (parent-transcript) tallies.
  activity?: {
    tools?: { name?: string; count?: number }[];
    commands?: { name?: string; count?: number }[];
    thinking_blocks?: number;
    orchestrator?: {
      tools?: { name?: string; count?: number }[];
      commands?: { name?: string; count?: number }[];
      thinking_blocks?: number;
    };
  };
  pr_lifecycle?: { observed?: boolean };
  /** ISS-4499: parent-transcript tool-result facts (subagentId == null). */
  tool_results?: {
    total?: number;
    errors?: number;
    session_error_records?: number;
    by_tool?: DossierToolResultByTool[];
  };
  /** ISS-4499: parseQuality counters (claude + codex dossiers only). */
  parse_quality?: {
    total_lines?: number;
    malformed_lines?: number;
    truncated_final_line?: boolean;
    unknown_records?: number;
    orphaned_tool_outputs?: number;
    ambiguous_tool_outputs?: number;
    malformed_rate_limits?: number;
  };
  /** ISS-4499: jsonNormalize-stripped usage extras, captured pre-normalize. */
  usage_extras?: {
    reasoning_output_tokens?: number;
    web_search_requests?: number;
  };
  notes?: string;
};

/** The Layer-1 orchestrator (parent-transcript) activity slice. */
type OrchestratorActivity = {
  tools?: { name?: string; count?: number }[];
  commands?: { name?: string; count?: number }[];
  thinking_blocks?: number;
};

/**
 * Resolve the orchestrator activity tallies regardless of schema_version:
 * schema v2 (FEA-2642) nests them under `activity.orchestrator.*`; schema v1
 * keeps them top-level under `activity.*`. Prefer the v2 nesting when present
 * so a v2 dossier is read from its canonical location, and fall back to the v1
 * top-level shape otherwise. These are the SAME Layer-1 parent-transcript facts
 * (the collector's orchestrator tallies) in both schemas.
 */
export function resolveOrchestratorActivity(
  exp: DossierExpectations
): OrchestratorActivity {
  return exp.activity?.orchestrator ?? exp.activity ?? {};
}

export type ParsedSubagentView = {
  id?: string;
  nativeSubagentId?: string | null;
  /** ISS-4592 writes the spawn's agent type onto every Claude subagent row. */
  type?: string | null;
  /** ISS-4592 writes the spawn's description under `metadata`. */
  metadata?: { description?: string | null } | null;
  tokensByModel?: Record<
    string,
    { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  >;
};

/** The Layer-1-relevant slice of a JSON-normalized parse result. */
export type ParsedSessionView = {
  userMessages?: number;
  assistantMessages?: number;
  model?: string | null;
  tokensByModel?: Record<
    string,
    {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cacheWriteTtl?: { fiveM?: number; oneH?: number };
    }
  >;
  subagents?: ParsedSubagentView[];
  thinkingBlockCount?: number;
  slashCommands?: { name?: string }[];
  toolUses?: {
    name?: string;
    subagentId?: string | null;
    output?: unknown;
    isError?: boolean;
  }[];
  codexForkedFromId?: string | null;
  compactions?: unknown[];
  artifacts?: {
    prs?: Array<{ number?: string }>;
  };
  prLinks?: Array<{ number?: string; repo?: string; url?: string }>;
  entrypoint?: string;
  permissionMode?: string | null;
  toolResultErrors?: unknown[];
  parseQuality?: {
    totalLines?: number;
    malformedLines?: number;
    truncatedFinalLine?: boolean;
    unknownRecords?: number;
    orphanedToolOutputs?: number;
    ambiguousToolOutputs?: number;
    malformedRateLimits?: number;
  };
  /** ISS-4499: usageExtras captured BEFORE jsonNormalize strips these fields. */
  capturedUsageExtras?: {
    reasoningOutputTokens?: number;
    webSearchRequests?: number;
  };
  /** ISS-4499: worker-parity failed-run signal computed pre-normalize. */
  endedOnUnrecoveredErrorComputed?: boolean;
};

export type Layer1Fact = {
  /** expectations.yaml key path — cited verbatim in failure messages */
  key: string;
  /** Extract the expected value from expectations.yaml (undefined = not asserted) */
  expected: (exp: DossierExpectations) => unknown;
  /** Extract the actual value from the parse result */
  actual: (s: ParsedSessionView) => unknown;
};

export function commandTally(
  entries: { name?: string; count?: number }[] | undefined
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const e of entries ?? []) {
    const name = e.name ?? "(unnamed)";
    tally[name] = (tally[name] ?? 0) + (e.count ?? 1);
  }
  return tally;
}

/**
 * The Layer-1-mappable dossier facts (FEA-2646): turn counts, model set,
 * per-model token totals, subagent count + per-child attribution, thinking
 * blocks, slash-command identities, parent-transcript tool tallies, compaction
 * flag, and pr_lifecycle.observed (FEA-3128: parser emitted harness pr-link
 * records). Cost/billing_mode are excluded by corpus convention (tested
 * separately); PR lifecycle enrichment and autonomy classification are Layer 2+.
 */
export const LAYER1_FACTS: Layer1Fact[] = [
  {
    key: "turns.user",
    expected: (e) => e.turns?.user,
    actual: (s) => s.userMessages,
  },
  {
    key: "turns.assistant",
    expected: (e) => e.turns?.assistant,
    actual: (s) => s.assistantMessages,
  },
  {
    key: "session.primary_model",
    expected: (e) => e.session?.primary_model ?? null,
    actual: (s) => s.model,
  },
  {
    key: "session.models_used",
    expected: (e) => [...(e.session?.models_used ?? [])].sort(),
    actual: (s) => Object.keys(s.tokensByModel ?? {}).sort(),
  },
  {
    key: "subagents.count",
    expected: (e) => e.subagents?.count,
    actual: (s) => (s.subagents ?? []).length,
  },
  {
    key: "activity.thinking_blocks",
    expected: (e) => resolveOrchestratorActivity(e).thinking_blocks,
    actual: (s) => s.thinkingBlockCount,
  },
  {
    key: "activity.commands",
    expected: (e) => commandTally(resolveOrchestratorActivity(e).commands),
    actual: (s) =>
      commandTally((s.slashCommands ?? []).map((c) => ({ name: c.name }))),
  },
  {
    key: "activity.tools",
    expected: (e) => commandTally(resolveOrchestratorActivity(e).tools),
    // Parent-transcript tally by corpus convention ("Activity elements used
    // (parent transcript)") — folded child toolUses carry a subagentId.
    actual: (s) =>
      commandTally(
        parentToolUses(s).map((tu) => ({
          name: tu.name,
        }))
      ),
  },
  {
    key: "session.lifecycle.forked",
    expected: (e) => e.session?.lifecycle?.forked,
    actual: (s) => s.codexForkedFromId != null,
  },
  {
    key: "session.lifecycle.compacted",
    expected: (e) => e.session?.lifecycle?.compacted,
    actual: (s) => (s.compactions ?? []).length > 0,
  },
  {
    key: "pr_lifecycle.observed",
    expected: (e) => e.pr_lifecycle?.observed,
    actual: (s) => (s.prLinks?.length ?? 0) > 0,
  },
];

const TOKEN_FIELD_MAP: [
  keyof DossierTokenCounts,
  "input" | "output" | "cacheRead" | "cacheWrite",
][] = [
  ["input", "input"],
  ["output", "output"],
  ["cache_read", "cacheRead"],
  ["cache_write", "cacheWrite"],
];

export function tokenFacts(exp: DossierExpectations): Layer1Fact[] {
  const models = Object.keys(exp.tokens_by_model ?? {}).sort();
  return models.flatMap((m) =>
    TOKEN_FIELD_MAP.map(([dossierField, parsedField]) => ({
      key: `tokens_by_model[${m}].${dossierField}`,
      expected: (e: DossierExpectations) =>
        e.tokens_by_model?.[m]?.[dossierField],
      actual: (s: ParsedSessionView) => s.tokensByModel?.[m]?.[parsedField],
    }))
  );
}

function findParsedSubagent(
  s: ParsedSessionView,
  subagentId: string
): ParsedSubagentView | undefined {
  return (s.subagents ?? []).find(
    (sub) => sub.id === subagentId || sub.nativeSubagentId === subagentId
  );
}

function subagentTokenTotal(
  sub: ParsedSubagentView | undefined,
  model: string | null | undefined,
  field: "input" | "output" | "cacheRead" | "cacheWrite"
): number | undefined {
  if (!sub) {
    return undefined;
  }
  // When the dossier names the child's model, read that model's counts — an
  // all-model sum would let tokens misattributed under another model still
  // satisfy the fact.
  if (model) {
    return sub.tokensByModel?.[model]?.[field] ?? 0;
  }
  let total = 0;
  for (const counts of Object.values(sub.tokensByModel ?? {})) {
    total += counts?.[field] ?? 0;
  }
  return total;
}

/**
 * Per-child attribution facts: presence, spawn identity (ISS-4702), model, and
 * the four token fields.
 *
 * ISS-4702: `agent_type` and `description` were recorded as oracle-class facts
 * but compared to nothing, so a transcription typo in a signed dossier survived
 * (f216298d's "Angle G" description). ISS-4592 writes both onto every Claude
 * subagent record, so they are assertable against the parse result today.
 */
export function subagentFacts(exp: DossierExpectations): Layer1Fact[] {
  const facts: Layer1Fact[] = [];
  for (const child of exp.subagents?.attributed ?? []) {
    const id = child.subagent_id;
    if (!id) {
      continue;
    }
    facts.push({
      key: `subagents.attributed[${id}].present`,
      expected: () => true,
      actual: (s) => findParsedSubagent(s, id) !== undefined,
    });
    if (child.agent_type !== undefined) {
      facts.push({
        key: `subagents.attributed[${id}].agent_type`,
        expected: () => child.agent_type,
        actual: (s) => findParsedSubagent(s, id)?.type,
      });
    }
    if (child.description !== undefined) {
      facts.push({
        key: `subagents.attributed[${id}].description`,
        expected: () => child.description,
        actual: (s) => findParsedSubagent(s, id)?.metadata?.description,
      });
    }
    if (child.model) {
      facts.push({
        key: `subagents.attributed[${id}].model`,
        expected: () => true,
        actual: (s) =>
          Object.keys(findParsedSubagent(s, id)?.tokensByModel ?? {}).includes(
            child.model as string
          ),
      });
    }
    for (const [dossierField, parsedField] of TOKEN_FIELD_MAP) {
      const expectedValue = child.tokens?.[dossierField];
      if (expectedValue === undefined) {
        continue;
      }
      facts.push({
        key: `subagents.attributed[${id}].tokens.${dossierField}`,
        expected: () => expectedValue,
        actual: (s) =>
          subagentTokenTotal(
            findParsedSubagent(s, id),
            child.model,
            parsedField
          ),
      });
    }
  }
  return facts;
}

/**
 * ISS-4499: worker-parity failed-run signal — the FULL formula the historical
 * parse worker stamps (`historical-parse-worker-protocol.ts`): preserve a
 * parser-set flag (never downgrade a known failure), otherwise derive. Never
 * reduce this to the derive alone.
 */
export function computeEndedOnUnrecoveredError(
  session: Pick<
    NormalizedSession,
    "apiErrors" | "messages" | "endedOnUnrecoveredError"
  >
): boolean {
  return (
    session.endedOnUnrecoveredError === true ||
    deriveEndedOnUnrecoveredError(session)
  );
}

/**
 * ISS-4499/FEA-3128: pre-normalize capture — prLinks and the usageExtras
 * fields jsonNormalize strips, plus the worker-parity failed-run signal,
 * all read from the raw parse BEFORE normalization. Spread into the
 * ParsedSessionView the fact builders read.
 */
export function captureLayer1Extras(
  rawParsed: NormalizedSession | null
): Pick<
  ParsedSessionView,
  "prLinks" | "capturedUsageExtras" | "endedOnUnrecoveredErrorComputed"
> {
  if (!rawParsed) {
    return {
      prLinks: [],
      capturedUsageExtras: undefined,
      endedOnUnrecoveredErrorComputed: undefined,
    };
  }
  return {
    prLinks: rawParsed.prLinks ?? [],
    capturedUsageExtras: {
      reasoningOutputTokens:
        rawParsed.usageExtras?.reasoning_output_tokens ?? 0,
      webSearchRequests: rawParsed.usageExtras?.web_search_requests ?? 0,
    },
    endedOnUnrecoveredErrorComputed: computeEndedOnUnrecoveredError(rawParsed),
  };
}

/** ISS-4499: session classification facts (entrypoint / permission mode / failed-run signal). */
export const SESSION_CLASSIFICATION_FACTS: Layer1Fact[] = [
  {
    key: "session.entrypoint",
    expected: (e) => e.session?.entrypoint,
    actual: (s) => s.entrypoint,
  },
  {
    key: "session.permission_mode",
    // Key-present semantics: an explicit `permission_mode: null` (codex) is
    // asserted as null; an absent key skips (required-facts enforces presence).
    expected: (e) =>
      e.session && "permission_mode" in e.session
        ? (e.session.permission_mode ?? null)
        : undefined,
    actual: (s) => s.permissionMode ?? null,
  },
  {
    key: "session.ended_on_unrecovered_error",
    expected: (e) => e.session?.ended_on_unrecovered_error,
    actual: (s) => s.endedOnUnrecoveredErrorComputed,
  },
];

function parentToolUses(
  s: ParsedSessionView
): NonNullable<ParsedSessionView["toolUses"]> {
  return (s.toolUses ?? []).filter((tu) => tu.subagentId == null);
}

/**
 * ISS-4499: parent-transcript tool-result facts. `total` counts tool uses with
 * a recorded output (`output !== undefined` — post-JSON-round-trip, the key is
 * present iff the parser recorded one); `errors` counts `isError === true`;
 * `session_error_records` reads the session-level `toolResultErrors` list
 * (survives jsonNormalize). Per-tool facts are generated from the oracle's
 * `by_tool` entries.
 */
export function toolResultFacts(exp: DossierExpectations): Layer1Fact[] {
  const facts: Layer1Fact[] = [
    {
      key: "tool_results.total",
      expected: (e) => e.tool_results?.total,
      actual: (s) =>
        parentToolUses(s).filter((tu) => tu.output !== undefined).length,
    },
    {
      key: "tool_results.errors",
      expected: (e) => e.tool_results?.errors,
      actual: (s) =>
        parentToolUses(s).filter((tu) => tu.isError === true).length,
    },
    {
      key: "tool_results.session_error_records",
      expected: (e) => e.tool_results?.session_error_records,
      actual: (s) => (s.toolResultErrors ?? []).length,
    },
  ];
  for (const entry of exp.tool_results?.by_tool ?? []) {
    const name = entry.name;
    if (!name) {
      continue;
    }
    facts.push(
      {
        key: `tool_results.by_tool[${name}].with_output`,
        expected: () => entry.with_output,
        actual: (s) =>
          parentToolUses(s).filter(
            (tu) => tu.name === name && tu.output !== undefined
          ).length,
      },
      {
        key: `tool_results.by_tool[${name}].errors`,
        expected: () => entry.errors,
        actual: (s) =>
          parentToolUses(s).filter(
            (tu) => tu.name === name && tu.isError === true
          ).length,
      }
    );
  }
  return facts;
}

/**
 * ISS-4499: parseQuality counters. Optional counters use `?? 0` on the actual
 * side — the parsers omit them when zero (FEA-3701/3702/3713 convention), so
 * absent-in-parser ≡ 0.
 */
export const PARSE_QUALITY_FACTS: Layer1Fact[] = [
  {
    key: "parse_quality.total_lines",
    expected: (e) => e.parse_quality?.total_lines,
    actual: (s) => s.parseQuality?.totalLines,
  },
  {
    key: "parse_quality.malformed_lines",
    expected: (e) => e.parse_quality?.malformed_lines,
    actual: (s) => s.parseQuality?.malformedLines,
  },
  {
    key: "parse_quality.truncated_final_line",
    expected: (e) => e.parse_quality?.truncated_final_line,
    actual: (s) => s.parseQuality?.truncatedFinalLine,
  },
  {
    key: "parse_quality.unknown_records",
    expected: (e) => e.parse_quality?.unknown_records,
    actual: (s) => s.parseQuality?.unknownRecords ?? 0,
  },
  {
    key: "parse_quality.orphaned_tool_outputs",
    expected: (e) => e.parse_quality?.orphaned_tool_outputs,
    actual: (s) => s.parseQuality?.orphanedToolOutputs ?? 0,
  },
  {
    key: "parse_quality.ambiguous_tool_outputs",
    expected: (e) => e.parse_quality?.ambiguous_tool_outputs,
    actual: (s) => s.parseQuality?.ambiguousToolOutputs ?? 0,
  },
  {
    key: "parse_quality.malformed_rate_limits",
    expected: (e) => e.parse_quality?.malformed_rate_limits,
    actual: (s) => s.parseQuality?.malformedRateLimits ?? 0,
  },
];

/**
 * ISS-4499: FEA-3419 cache-write TTL split. A populated oracle block against an
 * absent parser value FAILS (actual undefined ≠ expected number) — the split is
 * a hard Layer-1 token fact, never silently skipped.
 */
export function cacheWriteTtlFacts(exp: DossierExpectations): Layer1Fact[] {
  const facts: Layer1Fact[] = [];
  for (const m of Object.keys(exp.tokens_by_model ?? {}).sort()) {
    const ttl = exp.tokens_by_model?.[m]?.cache_write_ttl;
    if (!ttl) {
      continue;
    }
    facts.push(
      {
        key: `tokens_by_model[${m}].cache_write_ttl.five_m`,
        expected: () => ttl.five_m,
        actual: (s) => s.tokensByModel?.[m]?.cacheWriteTtl?.fiveM,
      },
      {
        key: `tokens_by_model[${m}].cache_write_ttl.one_h`,
        expected: () => ttl.one_h,
        actual: (s) => s.tokensByModel?.[m]?.cacheWriteTtl?.oneH,
      }
    );
  }
  return facts;
}

/**
 * ISS-4499: usageExtras facts — read from the PRE-normalize capture
 * (`capturedUsageExtras`) because jsonNormalize strips both fields from the
 * deep-equal projection. `?? 0` matches the parser contract (zeroed when the
 * source doesn't report them).
 */
export const USAGE_EXTRAS_FACTS: Layer1Fact[] = [
  {
    key: "usage_extras.reasoning_output_tokens",
    expected: (e) => e.usage_extras?.reasoning_output_tokens,
    actual: (s) => s.capturedUsageExtras?.reasoningOutputTokens ?? 0,
  },
  {
    key: "usage_extras.web_search_requests",
    expected: (e) => e.usage_extras?.web_search_requests,
    actual: (s) => s.capturedUsageExtras?.webSearchRequests ?? 0,
  },
];

const nonNegativeInt = z.number().int().nonnegative();

const cacheWriteTtlSchema = z
  .object({ five_m: nonNegativeInt, one_h: nonNegativeInt })
  .strict();

const toolResultsSchema = z
  .object({
    total: nonNegativeInt,
    errors: nonNegativeInt,
    session_error_records: nonNegativeInt,
    by_tool: z
      .array(
        z
          .object({
            name: z.string().min(1),
            with_output: nonNegativeInt,
            errors: nonNegativeInt,
          })
          .strict()
      )
      .optional(),
  })
  .strict();

const parseQualitySchema = z
  .object({
    total_lines: nonNegativeInt,
    malformed_lines: nonNegativeInt,
    truncated_final_line: z.boolean(),
    unknown_records: nonNegativeInt.optional(),
    orphaned_tool_outputs: nonNegativeInt.optional(),
    ambiguous_tool_outputs: nonNegativeInt.optional(),
    malformed_rate_limits: nonNegativeInt.optional(),
  })
  .strict();

const usageExtrasSchema = z
  .object({
    reasoning_output_tokens: nonNegativeInt,
    web_search_requests: nonNegativeInt,
  })
  .strict();

// The session block carries legacy keys outside ISS-4499's scope — type-check
// the new keys when present and pass unknown keys through (a typo'd NEW key
// is caught by the required-facts policy, which demands the correctly-spelled
// key on every assertable dossier).
const sessionNewKeysSchema = z
  .object({
    entrypoint: z.string().min(1).optional(),
    permission_mode: z.string().nullable().optional(),
    ended_on_unrecovered_error: z.boolean().optional(),
  })
  .catchall(z.unknown());

// tokens_by_model entries likewise carry legacy count keys; only the new
// cache_write_ttl block is strict.
const tokensByModelEntrySchema = z
  .object({ cache_write_ttl: cacheWriteTtlSchema.optional() })
  .catchall(z.unknown());

const newBlocksSchema = z
  .object({
    session: sessionNewKeysSchema.optional(),
    tool_results: toolResultsSchema.optional(),
    parse_quality: parseQualitySchema.optional(),
    tokens_by_model: z.record(z.string(), tokensByModelEntrySchema).optional(),
    usage_extras: usageExtrasSchema.optional(),
  })
  .catchall(z.unknown());

/**
 * ISS-4499: strict corpus-load validation of the new oracle blocks. Returns
 * human-readable issues (empty = valid). Wired into the "golden corpus
 * discovered and complete" test so a malformed new block fails the suite
 * loudly instead of silently disabling its assertion.
 */
export function validateNewExpectationBlocks(exp: unknown): string[] {
  const result = newBlocksSchema.safeParse(exp);
  if (result.success) {
    return [];
  }
  return result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`
  );
}

/**
 * Required expectations keys — a dossier missing any of these fails instead of
 * silently skipping the assertion (codex-review finding: optional-key skipping
 * lets a hollow dossier pass).
 *
 * ISS-4499: the new-block requirements activate only for dossiers with a
 * non-null normalized.json (`hasNormalized`) — a null-normalized dossier's
 * collector emits no session, so nothing is assertable — and are conditioned
 * on the dossier's harness (parse_quality is a claude+codex signal;
 * malformed_rate_limits is codex-only; the TTL-conservation rule is claude's).
 */
export function missingRequiredFacts(
  exp: DossierExpectations,
  opts: { hasNormalized: boolean; harness: Harness | undefined }
): string[] {
  const missing: string[] = [];
  const need = (cond: boolean, key: string) => {
    if (!cond) {
      missing.push(key);
    }
  };
  need(typeof exp.session?.status === "string", "session.status");
  need(
    exp.session?.billing_mode === "unknown",
    'session.billing_mode=="unknown"'
  );
  need(exp.session?.primary_model !== undefined, "session.primary_model");
  need(Array.isArray(exp.session?.models_used), "session.models_used");
  for (const flag of [
    "fresh",
    "resumed",
    "forked",
    "compacted",
    "interrupted",
  ] as const) {
    need(
      typeof exp.session?.lifecycle?.[flag] === "boolean",
      `session.lifecycle.${flag}`
    );
  }
  for (const t of ["total", "user", "assistant", "tool_result"] as const) {
    need(typeof exp.turns?.[t] === "number", `turns.${t}`);
  }
  const turns = exp.turns;
  if (turns) {
    need(
      (turns.total ?? 0) ===
        (turns.user ?? 0) + (turns.assistant ?? 0) + (turns.tool_result ?? 0),
      "turns.total==user+assistant+tool_result"
    );
  }
  need(
    typeof exp.tokens_by_model === "object" && exp.tokens_by_model !== null,
    "tokens_by_model"
  );
  need(exp.cost?.total === 0 && exp.cost?.metered_total === 0, "cost zeroed");
  need(typeof exp.subagents?.count === "number", "subagents.count");
  // Orchestrator activity: schema v2 nests under activity.orchestrator.*,
  // schema v1 keeps it top-level — resolveOrchestratorActivity() handles both.
  const orchestrator = resolveOrchestratorActivity(exp);
  need(Array.isArray(orchestrator.tools), "activity.tools");
  need(Array.isArray(orchestrator.commands), "activity.commands");
  need(
    typeof orchestrator.thinking_blocks === "number",
    "activity.thinking_blocks"
  );
  need(
    typeof exp.pr_lifecycle?.observed === "boolean",
    "pr_lifecycle.observed"
  );
  need(
    typeof exp.notes === "string" && exp.notes.trim().length > 0,
    "notes (evidence trail)"
  );
  if (opts.hasNormalized) {
    missing.push(...missingNewBlockFacts(exp, opts.harness));
  }
  return missing;
}

/**
 * ISS-4499 new-block requirements — factored out of {@link missingRequiredFacts}
 * so each policy stays readable. Applies only to dossiers with a non-null
 * normalized.json (the caller gates on `hasNormalized`).
 */
function missingNewBlockFacts(
  exp: DossierExpectations,
  harness: Harness | undefined
): string[] {
  const missing: string[] = [];
  const need = (cond: boolean, key: string) => {
    if (!cond) {
      missing.push(key);
    }
  };
  need(
    typeof exp.session?.entrypoint === "string" &&
      exp.session.entrypoint.length > 0,
    "session.entrypoint"
  );
  need(
    exp.session !== undefined && "permission_mode" in exp.session,
    "session.permission_mode (key present)"
  );
  need(
    typeof exp.session?.ended_on_unrecovered_error === "boolean",
    "session.ended_on_unrecovered_error"
  );
  need(
    typeof exp.tool_results === "object" && exp.tool_results !== null,
    "tool_results block"
  );
  need(
    typeof exp.usage_extras === "object" && exp.usage_extras !== null,
    "usage_extras block"
  );
  if (harness === Harness.Claude || harness === Harness.Codex) {
    need(
      typeof exp.parse_quality === "object" && exp.parse_quality !== null,
      "parse_quality block"
    );
  }
  if (harness === Harness.Codex) {
    need(
      typeof exp.parse_quality?.malformed_rate_limits === "number",
      "parse_quality.malformed_rate_limits"
    );
  }
  if (harness === Harness.Claude) {
    for (const [model, counts] of Object.entries(exp.tokens_by_model ?? {})) {
      if ((counts.cache_write ?? 0) > 0) {
        const ttl = counts.cache_write_ttl;
        need(ttl !== undefined, `tokens_by_model[${model}].cache_write_ttl`);
        if (ttl) {
          need(
            ttl.five_m + ttl.one_h === counts.cache_write,
            `tokens_by_model[${model}].cache_write_ttl conservation (five_m+one_h==cache_write)`
          );
        }
      }
    }
  }
  return missing;
}

/** Divergence entries that actually fired this run (three-way self-guard). */
const firedDivergences = new Set<string>();

/** Read-only view for the divergence-exercise sweep in golden-corpus.ts. */
export function getFiredDivergences(): ReadonlySet<string> {
  return firedDivergences;
}

export function checkFact(
  sessionId: string,
  fact: Layer1Fact,
  exp: DossierExpectations,
  parsed: ParsedSessionView,
  diagnostics: string[],
  failures: string[]
): void {
  const expected = fact.expected(exp);
  if (expected === undefined) {
    return; // dossier doesn't assert this key (required keys are enforced separately)
  }
  const actual = fact.actual(parsed);
  const divergence = findDivergence(sessionId, fact.key);
  const matches = isDeepStrictEqual(actual, expected);
  if (divergence) {
    firedDivergences.add(`${sessionId} ${fact.key}`);
    if (matches) {
      failures.push(
        `${fact.key} — registered divergence (${divergence.ticket}) no longer reproduces; ` +
          "a human must remove the golden-divergences.ts entry to promote this key to a hard assertion"
      );
    } else if (isDeepStrictEqual(actual, divergence.actual)) {
      diagnostics.push(
        `expected-fail ${sessionId}: ${fact.key} oracle=${JSON.stringify(expected)} parser=${JSON.stringify(actual)} (${divergence.ticket})`
      );
    } else {
      failures.push(
        `${fact.key} — parser drifted to a THIRD value ${JSON.stringify(actual)} ` +
          `(oracle ${JSON.stringify(expected)}, registered divergence ${JSON.stringify(divergence.actual)}, ${divergence.ticket}); new regression`
      );
    }
    return;
  }
  if (!matches) {
    failures.push(
      `${fact.key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} ` +
        `(oracle: packages/golden-sessions/${sessionId}/expectations.yaml → ${fact.key})`
    );
  }
}
