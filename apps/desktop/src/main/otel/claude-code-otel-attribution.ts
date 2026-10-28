/**
 * @file ISS-7352 item E — the per-component attribution Claude Code stamps on
 * every `claude_code.cost.usage` counter, and step 3's record of which source
 * produced it.
 *
 * This is the headline of the ticket: `agent.name`, `skill.name`,
 * `plugin.name`, `marketplace.name`, `mcp_server.name` and `mcp_tool.name` ride
 * on the counter itself, so the harness hands us the attribution that
 * ISS-7259/ISS-7261 otherwise reconstruct from transcripts.
 */

import { joinKeyParts } from "./claude-code-otel-key-encoding.js";

/**
 * The attribute keys carrying component attribution.
 *
 * Kept separate from the normalizer's general attribute-key set because these
 * are the only keys whose PRESENCE changes a COST row's identity — they widen
 * `claude_code_cost_event`'s natural key — rather than merely filling a column.
 *
 * `PluginName` and `MarketplaceName` are also what ISS-7352 item C's
 * `plugin_installed` / `plugin_loaded` events stamp. They are read from here
 * rather than respelled in `ClaudeCodeOtelAttributeKey`: one canonical spelling
 * per wire attribute, whichever signal happens to carry it.
 */
export const ClaudeCodeAttributionAttributeKey = {
  AgentName: "agent.name",
  SkillName: "skill.name",
  PluginName: "plugin.name",
  MarketplaceName: "marketplace.name",
  McpServerName: "mcp_server.name",
  McpToolName: "mcp_tool.name",
  QuerySource: "query_source",
  Speed: "speed",
  Effort: "effort",
} as const;
export type ClaudeCodeAttributionAttributeKey =
  (typeof ClaudeCodeAttributionAttributeKey)[keyof typeof ClaudeCodeAttributionAttributeKey];

/**
 * Which source produced a row's component attribution — ISS-7352 step 3,
 * recorded on every cost row.
 *
 * The set holds only values this repo can actually write today. Transcript
 * attribution lives at a different grain (`agent_component_invocations`, one
 * row per invocation) and no code joins the two yet, so a `transcript_derived`
 * member would be a value nothing ever sets. Recording `harness_otel` vs `none`
 * per row is what makes that later join decidable: a reader comparing the two
 * can see which measurements the harness itself attributed rather than having
 * to infer it from whether the columns happen to be populated — a NULL name
 * cannot distinguish "the harness said nothing" from "we never looked".
 */
export const ClaudeCodeAttributionSource = {
  /** The harness stamped at least one component name on the counter. */
  HarnessOtel: "harness_otel",
  /** No source attributed this measurement to a component. */
  None: "none",
} as const;
export type ClaudeCodeAttributionSource =
  (typeof ClaudeCodeAttributionSource)[keyof typeof ClaudeCodeAttributionSource];

/**
 * A cost counter's component attribution. Every field is optional because the
 * OTLP attribute set is sparse: a plain main-loop request carries none of them.
 */
export type ClaudeCodeComponentAttribution = {
  agentName?: string;
  skillName?: string;
  pluginName?: string;
  marketplaceName?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  querySource?: string;
  speed?: string;
  effort?: string;
};

/**
 * The identity-bearing fields, in the fixed order {@link attributionKeyOf}
 * serializes them.
 *
 * `speed` and `effort` are deliberately absent: they describe HOW a request was
 * run, not WHICH component ran it, so two points differing only in effort are
 * the same attributed series and must still aggregate together. Including them
 * would split one component's spend across rows on a dimension no reader
 * attributes cost by. The price of keeping them out is paid by
 * {@link agreedAttributionDimensions}: an aggregate may not report a dimension
 * its merged points disagreed on.
 */
const ATTRIBUTION_KEY_FIELDS = [
  "agentName",
  "skillName",
  "pluginName",
  "marketplaceName",
  "mcpServerName",
  "mcpToolName",
  "querySource",
] as const satisfies readonly (keyof ClaudeCodeComponentAttribution)[];

/**
 * The dimensions that FILL a cost row's columns without bearing identity — the
 * complement of {@link ATTRIBUTION_KEY_FIELDS}, named as its own list so the
 * two halves of that one decision cannot drift apart.
 */
const NON_IDENTITY_ATTRIBUTION_FIELDS = [
  "speed",
  "effort",
] as const satisfies readonly (keyof ClaudeCodeComponentAttribution)[];

/**
 * The canonical key for an attribution tuple, and `""` for an unattributed one.
 *
 * `""` is not a sentinel chosen for convenience — it is the value the migration
 * gives every row written before item E existed, so an old row and a genuinely
 * unattributed new one describe the same thing and share one natural key.
 *
 * The flattening is {@link joinKeyParts}, which is injective whatever the
 * values contain. It replaced a separator-joined form that rested on a rule
 * nothing enforced — no accepted value may contain the separator — under which
 * two different tuples could produce one key and the upsert then merged one
 * component's spend into another's row (whitlockk, ISS-7352 review).
 */
export function attributionKeyOf(
  attribution: ClaudeCodeComponentAttribution
): string {
  if (!hasComponentAttribution(attribution)) {
    return "";
  }
  return joinKeyParts(
    ATTRIBUTION_KEY_FIELDS.map((field) => attribution[field])
  );
}

/**
 * The non-identity dimensions of two points being MERGED, with any they
 * disagree about DROPPED.
 *
 * `speed`/`effort` stay out of the key so two points differing only in effort
 * remain one attributed series (see {@link ATTRIBUTION_KEY_FIELDS}) — but that
 * rationale and keeping the first point's value cannot both stand: the merged
 * row would report a summed cost paired with an effort no single measurement
 * carried, which is a value no producer emitted (whitlockk, ISS-7352 review). A
 * dimension the merged points do not agree on is not a property of the
 * aggregate. `undefined` is returned for a dropped field so the caller's
 * `withoutUndefinedValues` REMOVES the key rather than leaving a stale one.
 */
export function agreedAttributionDimensions(
  first: ClaudeCodeComponentAttribution,
  second: ClaudeCodeComponentAttribution
): ClaudeCodeComponentAttribution {
  const agreed: ClaudeCodeComponentAttribution = {};
  for (const field of NON_IDENTITY_ATTRIBUTION_FIELDS) {
    agreed[field] = first[field] === second[field] ? first[field] : undefined;
  }
  return agreed;
}

/**
 * Whether the harness named a component on this measurement.
 *
 * Reads only the identity fields: a point carrying `speed` alone is not
 * attributed to anything, and calling it attributed would put a non-empty key
 * on a row with no component names in it.
 */
function hasComponentAttribution(
  attribution: ClaudeCodeComponentAttribution
): boolean {
  return ATTRIBUTION_KEY_FIELDS.some(
    (field) => attribution[field] !== undefined
  );
}

/**
 * ISS-7352 step 3 — the source recorded on the row.
 *
 * Harness-stamped attribution wins wherever it exists, which at this grain is
 * by construction: `claude_code_cost_event` is written only by the OTel lane,
 * so nothing transcript-derived can be competing for the same row. The value is
 * still written per-row rather than assumed, so a consumer joining these rows
 * against transcript-derived attribution reads the winner off the record
 * instead of re-deriving it from which columns are populated.
 */
export function attributionSourceOf(
  attribution: ClaudeCodeComponentAttribution
): ClaudeCodeAttributionSource {
  return hasComponentAttribution(attribution)
    ? ClaudeCodeAttributionSource.HarnessOtel
    : ClaudeCodeAttributionSource.None;
}
