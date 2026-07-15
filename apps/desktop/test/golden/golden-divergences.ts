/**
 * FEA-2646: ticket-keyed registry of known collector-side divergences from the
 * human-signed golden dossiers (packages/golden-sessions).
 *
 * A entry here means: "the parser currently disagrees with the oracle on this
 * dossier key, a human confirmed the oracle is right, and <ticket> tracks the
 * collector fix." The Layer 1 runner reports these as expected-fails so CI stays
 * green — and FAILS LOUDLY if the divergence stops reproducing, forcing a human
 * to delete the entry and let the key become a hard assertion.
 *
 * Rules:
 * - Every entry MUST cite a real ticket (FEA-*).
 * - `actual` pins the parser's current (wrong) value: if the parser drifts to a
 *   THIRD value, that is a new regression and the runner fails hard.
 * - Entries for sessions not present in the corpus are inert (allows pre-seeding
 *   an entry for a dossier that arrives via a separate PR).
 * - Only humans adjudicate additions: agents may PROPOSE an entry in a PR, the
 *   reviewer owns accepting it (packages/golden-sessions/AGENTS.md).
 */

export type KnownDivergence = {
  /** Dossier directory name under packages/golden-sessions/ */
  sessionId: string;
  /** expectations.yaml key path the parser diverges on (e.g. "turns.user") */
  key: string;
  /** Tracking ticket for the collector fix */
  ticket: string;
  /** The parser's current (wrong) value, pinned so further drift fails hard */
  actual: unknown;
  /** One-line human-readable description of the divergence */
  note: string;
};

export const KNOWN_DIVERGENCES: KnownDivergence[] = [
  // FEA-3124 — user-turn attribution counts machine-injected user-role records
  // and misses command-only human turns (FEA-2192 sibling).
  {
    sessionId: "a3226ea3-d5ed-46f0-b456-457c8851fcab",
    key: "turns.user",
    ticket: "FEA-3124",
    actual: 6,
    note: "parser counts the Conductor-injected <system_instruction> user-role wrapper as a human turn (oracle: 5)",
  },
  {
    sessionId: "96fef0b5-1717-478c-91d5-5d36576ec254",
    key: "turns.user",
    ticket: "FEA-3124",
    actual: 10,
    note: "parser counts a 'Request interrupted by user' marker as a human message (oracle: 9)",
  },
  {
    sessionId: "6d6d2e80-0eba-41ab-af71-4d789e12f8b3",
    key: "turns.user",
    ticket: "FEA-3124",
    actual: 9,
    note: "parser counts one machine-generated user-role record as human (oracle: 8)",
  },
  {
    sessionId: "8998f3ad-3f84-7514-8465-2ee2d2cf9b6a",
    key: "turns.user",
    ticket: "FEA-3124",
    actual: 1,
    note: "fully SDK-driven codex call: parser counts the machine-embedded user-role prompt as a human turn (oracle: 0)",
  },
  {
    sessionId: "56f2ab4a-50a7-496a-8753-4ccece51efe2",
    key: "turns.user",
    ticket: "FEA-3124",
    actual: 1,
    note: "UNDER-count: /exit slash command is a human action per corpus turn semantics (oracle: 2)",
  },
  // FEA-3125 — codex assistantMessages basis: echo double-count + phantom turn
  // on zero-output sessions. turns.assistant = billable API round-trips
  // (2026-07-14 ruling).
  {
    sessionId: "8bbdbfab-d89a-78f7-bd3d-40e5b3a0a268",
    key: "turns.assistant",
    ticket: "FEA-3125",
    actual: 1,
    note: "phantom assistant turn: rollout has zero assistant records and zero token_count round-trips (oracle: 0)",
  },
  {
    sessionId: "8998f3ad-3f84-7514-8465-2ee2d2cf9b6a",
    key: "turns.assistant",
    ticket: "FEA-3125",
    actual: 1,
    note: "phantom assistant turn: SDK rollout has no model output anywhere (task_complete.last_agent_message null, zero assistant/output records) and no token_count events (oracle: 0)",
  },
  {
    sessionId: "7da87bc7-83f6-7bef-8524-edfc58585a4f",
    key: "turns.assistant",
    ticket: "FEA-3125",
    actual: 1,
    note: "zero-output session (task_complete with null last_agent_message, single null-info token_count) reported as 1 assistant turn (oracle: 0, # VERIFY in dossier)",
  },
  {
    sessionId: "f04610b7-baf0-7c5a-8a47-bb2206fc06b3",
    key: "turns.assistant",
    ticket: "FEA-3125",
    actual: 209,
    note: "≈ the 104 visible agent messages counted twice (response_item + event_msg echo); oracle: 114 billable round-trips",
  },
  {
    sessionId: "98a1952f-d39f-7cb6-8b61-a6b0285b81bf",
    key: "turns.assistant",
    ticket: "FEA-3125",
    actual: 276,
    note: "matches neither billable round-trips (295) nor visible messages (130); oracle: 295",
  },
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    key: "turns.assistant",
    ticket: "FEA-3125",
    actual: 35,
    note: "parent rollout has 26 billable round-trips / 17 visible messages; oracle: 26",
  },
  // FEA-3126 — codex parser double-adds reasoning_output_tokens into output
  // (reasoning is a SUBSET of output_tokens: input+output == total holds with
  // zero violations across every token_count event in these rollouts).
  {
    sessionId: "f04610b7-baf0-7c5a-8a47-bb2206fc06b3",
    key: "tokens_by_model[gpt-5.5].output",
    ticket: "FEA-3126",
    actual: 44_657,
    note: "44657 = 35943 output + 8714 reasoning (double-added); oracle: 35943",
  },
  {
    sessionId: "98a1952f-d39f-7cb6-8b61-a6b0285b81bf",
    key: "tokens_by_model[gpt-5.4].output",
    ticket: "FEA-3126",
    actual: 237_334,
    note: "237334 = 160209 output + 77125 reasoning (double-added); oracle: 160209",
  },
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    key: "tokens_by_model[gpt-5.5].output",
    ticket: "FEA-3126",
    actual: 110_673,
    note: "unit-wide (production fold): 110673 = 71115 output + 39558 reasoning double-added across parent+children; oracle: 71115",
  },
  // FEA-3126 per-child: every folded child's output carries its own reasoning
  // double-add (input/cache_read/cache_write all match — output only).
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    key: "subagents.attributed[b40650f9-4960-77a1-a29a-0534bfaafda3].tokens.output",
    ticket: "FEA-3126",
    actual: 11_725,
    note: "child output 7829 + reasoning double-added; oracle: 7829",
  },
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    key: "subagents.attributed[14de0924-2f19-74e2-8efe-320413bab576].tokens.output",
    ticket: "FEA-3126",
    actual: 20_390,
    note: "child output 12287 + reasoning double-added; oracle: 12287",
  },
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    key: "subagents.attributed[e37b5d2a-87f3-7c4b-95ee-af0fe5e1fd15].tokens.output",
    ticket: "FEA-3126",
    actual: 9850,
    note: "child output 6394 + reasoning double-added; oracle: 6394",
  },
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    key: "subagents.attributed[2388abbb-9c28-7983-a3cd-53489ce80adf].tokens.output",
    ticket: "FEA-3126",
    actual: 14_775,
    note: "child output 9221 + reasoning double-added; oracle: 9221",
  },
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    key: "subagents.attributed[fa082b7c-320c-7406-a607-1442d4b2ebcd].tokens.output",
    ticket: "FEA-3126",
    actual: 22_110,
    note: "child output 13281 + reasoning double-added; oracle: 13281",
  },
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    key: "subagents.attributed[7c5d6491-78e3-7058-bd62-02745a352ce8].tokens.output",
    ticket: "FEA-3126",
    actual: 9000,
    note: "child output 5514 + reasoning double-added; oracle: 5514",
  },
  // FEA-3153 — codex parser ignores tool_search_call records, so tool_search
  // never lands in toolUses (found when PR #2760 review promoted activity.tools
  // to an asserted fact).
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    key: "activity.tools",
    ticket: "FEA-3153",
    actual: {
      exec_command: 45,
      spawn_agent: 6,
      wait_agent: 6,
      close_agent: 6,
      list_projects: 1,
    },
    note: "parent tool tally is missing tool_search:1 — the tool_search_call record type is not extracted (oracle includes it)",
  },
  // FEA-3127 — codex parser drops compaction events (context_compacted never
  // populates NormalizedSession.compactions).
  {
    sessionId: "f04610b7-baf0-7c5a-8a47-bb2206fc06b3",
    key: "session.lifecycle.compacted",
    ticket: "FEA-3127",
    actual: false,
    note: "raw has compacted record L646 + context_compacted event L649; parser reports no compactions (oracle: true)",
  },
  {
    sessionId: "98a1952f-d39f-7cb6-8b61-a6b0285b81bf",
    key: "session.lifecycle.compacted",
    ticket: "FEA-3127",
    actual: false,
    note: "raw has 2x compacted records + 2x context_compacted events; parser reports no compactions (oracle: true)",
  },
];

export function findDivergence(
  sessionId: string,
  key: string
): KnownDivergence | undefined {
  return KNOWN_DIVERGENCES.find(
    (d) => d.sessionId === sessionId && d.key === key
  );
}
