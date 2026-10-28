/**
 * The transcript turn IDENTITY record, split out of `agent-session.ts` (which is
 * over the file-size ceiling) into a dependency-free leaf.
 *
 * It lives alone because it is the one shape depended on from BOTH sides of the
 * transcript contract: the tool-call detail module
 * (`./agent-session-tool-call.ts`) hangs it off a `ToolItem`, and the turn render
 * shapes (`./session-transcript-turn.ts`) hang it off every addressable turn.
 * While it sat in `agent-session.ts`, that first edge was a type-only import
 * cycle back into the validator graph, tolerated and documented rather than
 * fixed; a leaf module with no imports of its own removes the cycle instead of
 * restating it.
 */

/**
 * Stable, additive identities carried from a transcript/DB source through the
 * shared detail projection. Timestamp ordinals disambiguate rows emitted at an
 * identical instant; producer ids are preserved when available so deep links
 * never have to infer a target from display text.
 */
export type TranscriptTurnIdentity = {
  eventId?: string;
  providerToolUseId?: string;
  agentId?: string;
  externalAgentId?: string;
  userTurnId?: string;
  timestamp?: string;
  timestampOrdinal?: number;
};
