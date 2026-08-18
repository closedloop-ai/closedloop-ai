/**
 * Shared `TurnItem` row builders for the FEA-4252 timeline-row-space suites.
 * Extracted so the row-translation tests split into cohesive sibling files
 * (`timeline-row-space.test.ts` — the staged strong-id/group-tag/skeleton
 * matching, and `timeline-row-space-nearest-time.test.ts` — the nearest-time
 * fallback and its plausibility/tie/epoch/subagent-scoping guards) without either
 * re-declaring these builders. Every builder mints a single row in the DB or
 * cloud `session.turnItems` projection so a suite can compose a divergent pair.
 */

import type { TurnItem } from "@repo/api/src/types/agent-session";

export function promptRow(
  row: number,
  userTurnId: string,
  text: string
): TurnItem {
  return {
    type: "prompt",
    _row: row,
    t: "2026-07-09T10:00:00.000Z",
    tMs: Date.parse("2026-07-09T10:00:00.000Z"),
    cum: 0,
    actor: { name: null, sessionId: "s1", human: "Ada", color: "#000" },
    text,
    transcriptIdentity: { userTurnId },
  };
}

export function sayRow(row: number, text: string): TurnItem {
  return {
    type: "say",
    _row: row,
    t: "2026-07-09T10:00:00.500Z",
    tMs: Date.parse("2026-07-09T10:00:00.500Z"),
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    text,
    transcriptIdentity: { timestamp: `say-${row}`, timestampOrdinal: 0 },
  };
}

/** A say row whose only identity is a same-instant timestamp + ordinal. */
export function idlessSay(
  row: number,
  timestamp: string,
  ordinal: number
): TurnItem {
  return {
    type: "say",
    _row: row,
    t: timestamp,
    tMs: Date.parse(timestamp),
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    text: `say-${row}`,
    transcriptIdentity: { timestamp, timestampOrdinal: ordinal },
  };
}

export function toolsRow(
  row: number,
  providerToolUseId: string,
  timestamp: string | null
): TurnItem {
  return {
    type: "tools",
    _row: row,
    t: timestamp ?? "2026-07-09T10:00:01.000Z",
    tMs: Date.parse(timestamp ?? "2026-07-09T10:00:01.000Z"),
    endMs: Date.parse(timestamp ?? "2026-07-09T10:00:01.000Z"),
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    summary: "Ran 1 tool",
    items: [
      {
        label: "Bash",
        detail: "",
        err: false,
        transcriptIdentity: { providerToolUseId },
      },
    ],
    hasFail: false,
    failN: 0,
    cats: {},
  };
}

export function subagentRow(row: number, externalAgentId: string): TurnItem {
  return {
    type: "subagent",
    _row: row,
    t: "2026-07-09T10:00:02.000Z",
    tMs: Date.parse("2026-07-09T10:00:02.000Z"),
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    sub: "reviewer",
    subagentType: null,
    status: "completed",
    model: null,
    duration: null,
    tokens: null,
    cost: null,
    body: [],
    transcriptIdentity: { externalAgentId },
  };
}

export function subagentWithEventId(
  row: number,
  externalAgentId: string,
  eventId: string
): TurnItem {
  return {
    type: "subagent",
    _row: row,
    t: "2026-07-09T10:00:02.000Z",
    tMs: Date.parse("2026-07-09T10:00:02.000Z"),
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    sub: "reviewer",
    subagentType: null,
    status: "completed",
    model: null,
    duration: null,
    tokens: null,
    cost: null,
    body: [],
    transcriptIdentity: { externalAgentId, eventId },
  };
}

/** A tools turn that only carries the subagent's group tag (no strong id). */
export function subagentToolGroup(
  row: number,
  externalAgentId: string
): TurnItem {
  return {
    type: "tools",
    _row: row,
    t: "2026-07-09T10:00:01.500Z",
    tMs: Date.parse("2026-07-09T10:00:01.500Z"),
    endMs: Date.parse("2026-07-09T10:00:01.500Z"),
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    summary: "Ran 1 tool",
    items: [
      {
        label: "Bash",
        detail: "",
        err: false,
        transcriptIdentity: { externalAgentId },
      },
    ],
    hasFail: false,
    failN: 0,
    cats: {},
  };
}

/** A subagent turn carrying only its group tag, at a caller-chosen HH:MM:SS. */
export function subagentGroupAt(
  row: number,
  externalAgentId: string,
  hms: string
): TurnItem {
  const iso = `2026-07-09T${hms}.000Z`;
  return {
    type: "subagent",
    _row: row,
    t: iso,
    tMs: Date.parse(iso),
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    sub: "reviewer",
    subagentType: null,
    status: "completed",
    model: null,
    duration: null,
    tokens: null,
    cost: null,
    body: [],
    transcriptIdentity: { externalAgentId },
  };
}

/** A subagent group-tag turn with NO usable timestamp (nearest-time yields null). */
export function subagentGroupUntimed(
  row: number,
  externalAgentId: string
): TurnItem {
  return {
    type: "subagent",
    _row: row,
    t: "",
    tMs: Number.NaN,
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    sub: "reviewer",
    subagentType: null,
    status: "completed",
    model: null,
    duration: null,
    tokens: null,
    cost: null,
    body: [],
    transcriptIdentity: { externalAgentId },
  };
}

/** A say turn with no usable timestamp and no strong id. */
export function untimedSay(row: number, text: string): TurnItem {
  return {
    type: "say",
    _row: row,
    t: "",
    tMs: Number.NaN,
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    text,
    transcriptIdentity: {},
  };
}

/**
 * A say turn whose only timestamp is the Unix-epoch sentinel (`0` /
 * `1970-01-01T00:00:00.000Z`) some producers emit for a missing instant, with no
 * strong id. `turnItemMs` must treat it as no-usable-time, not a real 1970 instant.
 */
export function epochSentinelSay(row: number): TurnItem {
  return {
    type: "say",
    _row: row,
    t: "1970-01-01T00:00:00.000Z",
    tMs: 0,
    cum: 0,
    actor: { name: "claude", sessionId: "s1", human: null, color: "#111" },
    text: `epoch-${row}`,
    transcriptIdentity: {},
  };
}
