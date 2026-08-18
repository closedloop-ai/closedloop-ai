/**
 * @file codex-protocol-inventory.ts
 * @description FEA-3715 (Parser roadmap 9): the reviewed, machine-readable
 * inventory of the official OpenAI Codex rollout protocol surface plus the
 * parser's coverage map, and a pure drift-detector that compares the two.
 *
 * WHY THIS EXISTS. Codex's rollout enums and persistence mechanics evolve
 * quickly (`parse-codex.ts` documents years of format drift). Manual parser
 * updates lag upstream, so a newly-shipped Codex variant can silently produce
 * missing data until a user notices. This module turns that invisible lag into
 * a CI failure: the {@link CODEX_PROTOCOL_INVENTORY} pin is the reviewed truth
 * of what Codex emits, {@link CODEX_PARSER_COVERAGE} declares what our parser
 * does with each variant/field (decoded / explicitly ignored / preserved
 * opaque), and {@link diffInventoryAgainstCoverage} fails when they diverge.
 * The paired test additionally cross-checks the `decoded` coverage entries
 * against the parser's LIVE handler registries, so a handler added or removed
 * in `parse-codex.ts` without a matching coverage edit also fails.
 *
 * DETERMINISM / PIN-UPDATE WORKFLOW (acceptance criterion 4). The inventory is
 * a checked-in constant — the tests NEVER fetch mutable upstream source. To
 * track a new Codex release a human:
 *   1. reviews the upstream rollout schema at a new commit,
 *   2. updates {@link CODEX_PROTOCOL_SUPPORT} (the pinned commit + review date)
 *      and {@link CODEX_PROTOCOL_INVENTORY} to match, then
 *   3. wires (or explicitly ignores, with a rationale) each new variant in
 *      `parse-codex.ts` + {@link CODEX_PARSER_COVERAGE} until the drift test and
 *      the live-registry cross-check both go green again.
 * The pin is recorded in the parser output (`session.codexProtocolSupport`) so
 * every parsed Codex session self-documents the protocol understanding that
 * decoded it.
 *
 * Reference: steipete/CodexBar `docs/codex.md` (MIT) — see THIRD_PARTY_NOTICES.md.
 */

import type { CodexProtocolSupport } from "../types";

export type { CodexProtocolSupport } from "../types";

/**
 * The pinned Codex protocol reference this inventory was reviewed against, and
 * the supported-version anchor recorded in the parser output. The pinned commit
 * is the range anchor: the inventory is understood to apply from this reviewed
 * commit forward until the next reviewed pin update (see the workflow above).
 */
export const CODEX_PROTOCOL_SUPPORT = {
  /** Upstream reference repository the rollout schema was reviewed from. */
  referenceRepo: "steipete/CodexBar",
  /** The exact commit the current inventory pin was reviewed against. */
  pinnedCommit: "963cda85aa2a4cfb85e52d771d22d9f3069951fa",
  /** ISO date (UTC) the pin was last human-reviewed. */
  reviewedOn: "2026-07-22",
  /**
   * Human-readable description of the supported version/commit range. The pin is
   * open-ended: it applies from `pinnedCommit` forward until a reviewer advances
   * it (a newer Codex release is not "supported" until re-reviewed).
   */
  supportedRange: "codex rollout schema at pinnedCommit forward (open-ended)",
} as const satisfies CodexProtocolSupport;

/**
 * The coarse Codex protocol surfaces the inventory tracks. `rollout_item` is the
 * outer RolloutLine envelope discriminator; `event_msg` and `response_item` are
 * the variant-heavy inner payloads; `content`, `session_meta`, and `turn_context`
 * are field/block sets the parser reads.
 */
export type CodexProtocolCategory =
  | "rollout_item"
  | "response_item"
  | "content"
  | "session_meta"
  | "turn_context"
  | "event_msg";

export const CODEX_PROTOCOL_CATEGORIES: readonly CodexProtocolCategory[] = [
  "rollout_item",
  "response_item",
  "content",
  "session_meta",
  "turn_context",
  "event_msg",
] as const;

/**
 * How the parser handles a known variant/field:
 * - `decoded` — the parser extracts data from it (must have a live handler for
 *   the registry-backed `event_msg` / `response_item` categories).
 * - `ignored` — the parser recognizes it exists but intentionally drops it; a
 *   `rationale` is required so the omission is a documented decision.
 * - `opaque` — preserved without interpretation; a `rationale` is required.
 */
export type CodexVariantDisposition = "decoded" | "ignored" | "opaque";

/** One official variant/field in the reviewed inventory pin. */
export type CodexInventoryEntry = {
  name: string;
  /** serde aliases upstream accepts for the same variant/field, if any. */
  aliases?: readonly string[];
};

/** The reviewed inventory: official variants/fields per category. */
export type CodexProtocolInventory = Record<
  CodexProtocolCategory,
  readonly CodexInventoryEntry[]
>;

/** The parser's declared stance on one inventory variant/field. */
export type CodexCoverageEntry = {
  name: string;
  disposition: CodexVariantDisposition;
  /** Required for `ignored` / `opaque`; documents why it is not decoded. */
  rationale?: string;
  aliases?: readonly string[];
};

/** The parser coverage map: a disposition for every inventory variant/field. */
export type CodexParserCoverage = Record<
  CodexProtocolCategory,
  readonly CodexCoverageEntry[]
>;

/**
 * The reviewed inventory of the official Codex rollout protocol surface at
 * {@link CODEX_PROTOCOL_SUPPORT.pinnedCommit}. Grounded in `parse-codex.ts`'s
 * `classify` / `extractText` / `applySessionMeta` / `applyTurnContext` and the
 * `RESPONSE_ITEM_HANDLERS` / `EVENT_HANDLERS` registries — the variants the
 * parser was built from are, by construction, ones Codex emits.
 *
 * `compacted` is architecturally a RolloutItem, but this parser decodes it
 * through the event registry (classify's bare-`type` fallback), so it is
 * inventoried under `event_msg` alongside the events it is dispatched with.
 */
export const CODEX_PROTOCOL_INVENTORY: CodexProtocolInventory = {
  // Outer RolloutLine envelope discriminators. classify() also accepts the
  // dotted serde aliases below.
  rollout_item: [
    { name: "session_meta", aliases: ["session.created"] },
    { name: "turn_context", aliases: ["turn.context"] },
    { name: "event_msg", aliases: ["event"] },
    { name: "response_item", aliases: ["response.item"] },
  ],
  // Responses-API item variants carried under a response_item envelope.
  response_item: [
    { name: "message" },
    { name: "reasoning" },
    { name: "function_call" },
    { name: "function_call_output" },
    { name: "local_shell_call" },
    { name: "local_shell_call_output" },
    { name: "custom_tool_call" },
    { name: "custom_tool_call_output" },
    { name: "tool_search_call" },
  ],
  // Content block `type`s the parser flattens to text (extractText).
  content: [{ name: "input_text" }, { name: "output_text" }, { name: "text" }],
  // SessionMeta fields the parser reads (applySessionMeta) or uses to classify
  // a bare session_meta record.
  session_meta: [
    { name: "cwd", aliases: ["workdir"] },
    { name: "originator" },
    { name: "cli_version", aliases: ["version"] },
    { name: "git" },
    { name: "git_branch" },
    { name: "model" },
    { name: "session_id", aliases: ["id"] },
    { name: "instructions" },
  ],
  // TurnContext fields the parser reads (applyTurnContext).
  turn_context: [{ name: "model" }, { name: "cwd" }],
  // EventMsg variants. The `decoded` names below must stay in lockstep with
  // parse-codex.ts's EVENT_HANDLERS keys (asserted by the paired test); the
  // trailing streamed-lifecycle companions are recognized-but-ignored.
  event_msg: [
    { name: "item_completed" },
    { name: "user_message" },
    { name: "agent_message" },
    { name: "agent_message_delta" },
    { name: "agent_reasoning" },
    { name: "agent_reasoning_section_break" },
    { name: "token_count" },
    { name: "task_started" },
    { name: "compacted" },
    { name: "context_compacted" },
    { name: "error" },
    { name: "stream_error" },
    { name: "exec_command_begin" },
    { name: "patch_apply_begin" },
    { name: "mcp_tool_call_begin" },
    { name: "mcp_tool_call_end" },
    // Streamed-lifecycle companions to decoded *_begin/started events (ignored).
    { name: "exec_command_end" },
    { name: "exec_command_output_delta" },
    { name: "patch_apply_end" },
    { name: "task_complete" },
  ],
};

const IGNORED_LIFECYCLE_RATIONALE =
  "Streamed lifecycle companion to a decoded *_begin/started event; carries no independent token, message, or tool fact the parser needs, so classify → dispatchEvent skips it (no handler registered).";

const CLASSIFY_SIGNAL_RATIONALE =
  "Used only as a signal to classify a bare (envelope-less) session_meta record; not surfaced on the normalized session.";

/**
 * The parser's coverage stance for every inventory variant/field. Every name in
 * {@link CODEX_PROTOCOL_INVENTORY} appears here exactly once, per category, with
 * matching aliases — {@link diffInventoryAgainstCoverage} enforces that.
 */
export const CODEX_PARSER_COVERAGE: CodexParserCoverage = {
  rollout_item: [
    {
      name: "session_meta",
      disposition: "decoded",
      aliases: ["session.created"],
    },
    { name: "turn_context", disposition: "decoded", aliases: ["turn.context"] },
    { name: "event_msg", disposition: "decoded", aliases: ["event"] },
    {
      name: "response_item",
      disposition: "decoded",
      aliases: ["response.item"],
    },
  ],
  response_item: [
    { name: "message", disposition: "decoded" },
    { name: "reasoning", disposition: "decoded" },
    { name: "function_call", disposition: "decoded" },
    { name: "function_call_output", disposition: "decoded" },
    { name: "local_shell_call", disposition: "decoded" },
    { name: "local_shell_call_output", disposition: "decoded" },
    { name: "custom_tool_call", disposition: "decoded" },
    { name: "custom_tool_call_output", disposition: "decoded" },
    { name: "tool_search_call", disposition: "decoded" },
  ],
  content: [
    { name: "input_text", disposition: "decoded" },
    { name: "output_text", disposition: "decoded" },
    { name: "text", disposition: "decoded" },
  ],
  session_meta: [
    { name: "cwd", disposition: "decoded", aliases: ["workdir"] },
    { name: "originator", disposition: "decoded" },
    { name: "cli_version", disposition: "decoded", aliases: ["version"] },
    { name: "git", disposition: "decoded" },
    { name: "git_branch", disposition: "decoded" },
    { name: "model", disposition: "decoded" },
    {
      name: "session_id",
      disposition: "ignored",
      rationale: CLASSIFY_SIGNAL_RATIONALE,
      aliases: ["id"],
    },
    {
      name: "instructions",
      disposition: "ignored",
      rationale: CLASSIFY_SIGNAL_RATIONALE,
    },
  ],
  turn_context: [
    { name: "model", disposition: "decoded" },
    { name: "cwd", disposition: "decoded" },
  ],
  event_msg: [
    { name: "item_completed", disposition: "decoded" },
    { name: "user_message", disposition: "decoded" },
    { name: "agent_message", disposition: "decoded" },
    { name: "agent_message_delta", disposition: "decoded" },
    { name: "agent_reasoning", disposition: "decoded" },
    { name: "agent_reasoning_section_break", disposition: "decoded" },
    { name: "token_count", disposition: "decoded" },
    { name: "task_started", disposition: "decoded" },
    { name: "compacted", disposition: "decoded" },
    { name: "context_compacted", disposition: "decoded" },
    { name: "error", disposition: "decoded" },
    { name: "stream_error", disposition: "decoded" },
    { name: "exec_command_begin", disposition: "decoded" },
    { name: "patch_apply_begin", disposition: "decoded" },
    { name: "mcp_tool_call_begin", disposition: "decoded" },
    { name: "mcp_tool_call_end", disposition: "decoded" },
    {
      name: "exec_command_end",
      disposition: "ignored",
      rationale: IGNORED_LIFECYCLE_RATIONALE,
    },
    {
      name: "exec_command_output_delta",
      disposition: "ignored",
      rationale: IGNORED_LIFECYCLE_RATIONALE,
    },
    {
      name: "patch_apply_end",
      disposition: "ignored",
      rationale: IGNORED_LIFECYCLE_RATIONALE,
    },
    {
      name: "task_complete",
      disposition: "ignored",
      rationale: IGNORED_LIFECYCLE_RATIONALE,
    },
  ],
};

/** A single divergence between the inventory pin and the parser coverage map. */
export type CodexInventoryDriftKind =
  | "unreviewed_addition"
  | "stale_coverage"
  | "alias_change";

export type CodexInventoryDrift = {
  kind: CodexInventoryDriftKind;
  category: CodexProtocolCategory;
  name: string;
  detail: string;
};

function aliasSet(aliases: readonly string[] | undefined): Set<string> {
  return new Set(aliases ?? []);
}

function aliasesDiffer(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  const sa = aliasSet(a);
  const sb = aliasSet(b);
  if (sa.size !== sb.size) {
    return true;
  }
  for (const value of sa) {
    if (!sb.has(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Compare a reviewed inventory pin against a parser coverage map and return
 * every divergence. Empty result === in sync. A variant present in the inventory
 * but missing from coverage is an `unreviewed_addition` (upstream shipped a
 * variant we have not dispositioned); present in coverage but missing from the
 * inventory is `stale_coverage` (our map references something the pin no longer
 * lists); a variant present in both whose serde alias set differs is an
 * `alias_change`. A rename surfaces as one `stale_coverage` (old name) plus one
 * `unreviewed_addition` (new name).
 *
 * Pure and side-effect-free — the CI gate asserts this returns [] for the
 * checked-in pin; the regression fixtures feed mutated inventories to prove each
 * drift kind is caught.
 */
export function diffInventoryAgainstCoverage(
  inventory: CodexProtocolInventory,
  coverage: CodexParserCoverage
): CodexInventoryDrift[] {
  const drifts: CodexInventoryDrift[] = [];
  for (const category of CODEX_PROTOCOL_CATEGORIES) {
    const inventoryEntries = inventory[category] ?? [];
    const coverageEntries = coverage[category] ?? [];
    const coverageByName = new Map(coverageEntries.map((e) => [e.name, e]));
    const inventoryByName = new Map(inventoryEntries.map((e) => [e.name, e]));

    for (const entry of inventoryEntries) {
      const covered = coverageByName.get(entry.name);
      if (!covered) {
        drifts.push({
          kind: "unreviewed_addition",
          category,
          name: entry.name,
          detail: `inventory variant "${entry.name}" has no coverage entry — wire a handler or add an explicit ignored/opaque disposition`,
        });
        continue;
      }
      if (aliasesDiffer(entry.aliases, covered.aliases)) {
        drifts.push({
          kind: "alias_change",
          category,
          name: entry.name,
          detail: `alias set for "${entry.name}" differs between inventory [${[...aliasSet(entry.aliases)].sort().join(", ")}] and coverage [${[...aliasSet(covered.aliases)].sort().join(", ")}]`,
        });
      }
    }

    for (const entry of coverageEntries) {
      if (!inventoryByName.has(entry.name)) {
        drifts.push({
          kind: "stale_coverage",
          category,
          name: entry.name,
          detail: `coverage entry "${entry.name}" is absent from the reviewed inventory — remove it or restore the variant to the pin`,
        });
      }
    }
  }
  return drifts;
}
