/**
 * @file codex-launch-attribution.ts
 * @description ISS-7259: the Codex half of harness launch attribution — reading
 * `session_meta`'s spawn block and folding it into the shared
 * {@link HarnessLaunchAttribution} shape.
 *
 * Split out of `parse-codex.ts` rather than added to it: this is a
 * self-contained concern with its own accumulator, its own first-wins rules, and
 * one narrow input record type.
 */
import type { HarnessLaunchAttribution } from "../launch-attribution";
import {
  buildHarnessLaunchAttribution,
  LaunchThreadSource,
  normalizeLaunchThreadSource,
} from "../launch-attribution";
import { asRecord } from "../type-guards";

/**
 * Launch attribution gathered across a rollout's `session_meta` records.
 *
 * Every member is first-wins, so a later record restating a field cannot revise
 * it — a rollout can carry several `session_meta` records and the earliest
 * statement is the one about how this thread began.
 */
export type CodexLaunchAttributionAccumulator = {
  threadSource: LaunchThreadSource | null;
  agentRole: string | null;
  agentNickname: string | null;
  parentThreadId: string | null;
  depth: number | null;
};

export function createCodexLaunchAttributionAccumulator(): CodexLaunchAttributionAccumulator {
  return {
    threadSource: null,
    agentRole: null,
    agentNickname: null,
    parentThreadId: null,
    depth: null,
  };
}

/**
 * Fold one `session_meta` payload into the accumulator.
 *
 * `source` is polymorphic — a bare string (`"cli"`, `"exec"`, `"vscode"`) for a
 * user-started thread, an object only for a spawned one — so every read here has
 * to tolerate both. Role and nickname are stated in up to THREE places: the
 * payload top level, `source.subagent` directly, and `source.subagent.thread_spawn`.
 * All three are read, in that order, so a version dropping any one copy still
 * yields the attribution. `source.subagent` is not optional to read: it is where
 * the canonical desktop fixture and the collector below both put these fields,
 * and omitting it dropped role and nickname while parent and depth still landed —
 * a facet that looks populated and is quietly incomplete.
 * `threadSource` is NOT one of those: across the observed corpus it
 * appears only at the top level and never inside `thread_spawn`, so it is read
 * from exactly one place. Do not add a nested fallback for it on the strength of
 * this comment — that would be handling for a shape no provider emits.
 *
 * `agent_path` is deliberately NOT captured. It is the only member of the block
 * carrying task-derived free text (observed: `/root/multiplayer_sync_triage`),
 * so it would push a description of what the user was working on into cloud
 * metadata to buy nothing the role and nickname do not already say.
 *
 * SECOND READER: the desktop collector's `readCodexRolloutLinkage`
 * (apps/desktop/src/main/collectors/codex/codex-subagent-rollouts.ts) already
 * pulls these fields off this same payload for subagent graph traversal.
 * `packages/lib` cannot import from `apps/desktop`, so this is a deliberate
 * MIRROR rather than a shared helper. This reader's location set is a SUPERSET
 * of the collector's: the collector reads `source.subagent.<field>` then the
 * nested `thread_spawn`, and this reads the payload top level before those same
 * two. The extra top-level read is the only asymmetry left, so the two can
 * disagree only on a rollout that states a field at the top level and a
 * DIFFERENT one under `source.subagent`. Change them together.
 *
 * `parentThreadId` is passed in rather than re-derived: `parse-codex.ts` already
 * computes it via `codexParentThreadId` for its fork-lineage check, and deriving
 * it twice is how the two answers drift apart.
 */
export function applyCodexSessionMetaLaunchAttribution(
  accumulator: CodexLaunchAttributionAccumulator,
  payload: Record<string, unknown>,
  parentThreadId: string | null
): void {
  const subagent = asRecord(asRecord(payload.source)?.subagent);
  const threadSpawn = asRecord(subagent?.thread_spawn);
  // Only a STATED spawn word is retained, so a later record that does state one
  // is not blocked by an earlier record that said nothing.
  if (accumulator.threadSource === null) {
    const threadSource = normalizeLaunchThreadSource(payload.thread_source);
    accumulator.threadSource =
      threadSource === LaunchThreadSource.Unstated ? null : threadSource;
  }
  accumulator.agentRole ??=
    stringOrNull(payload.agent_role) ??
    stringOrNull(subagent?.agent_role) ??
    stringOrNull(threadSpawn?.agent_role);
  accumulator.agentNickname ??=
    stringOrNull(payload.agent_nickname) ??
    stringOrNull(subagent?.agent_nickname) ??
    stringOrNull(threadSpawn?.agent_nickname);
  accumulator.parentThreadId ??= parentThreadId;
  if (accumulator.depth === null) {
    accumulator.depth = depthOrNull(threadSpawn?.depth);
  }
}

/** The facet for a rollout, or `undefined` when `session_meta` stated none. */
export function buildCodexLaunchAttribution(
  accumulator: CodexLaunchAttributionAccumulator
): HarnessLaunchAttribution | undefined {
  return buildHarnessLaunchAttribution({
    ...(accumulator.threadSource
      ? { threadSource: accumulator.threadSource }
      : {}),
    ...(accumulator.agentRole ? { agentRole: accumulator.agentRole } : {}),
    ...(accumulator.agentNickname
      ? { agentNickname: accumulator.agentNickname }
      : {}),
    ...(accumulator.parentThreadId
      ? { parentThreadId: accumulator.parentThreadId }
      : {}),
    ...(accumulator.depth === null ? {} : { depth: accumulator.depth }),
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A `thread_spawn.depth` that is a real hierarchy level, or `null`.
 *
 * `depth` arrives as transcript JSON, so the type system constrains nothing: it
 * is gated here on a NON-NEGATIVE INTEGER rather than merely a finite number.
 * The two rejected shapes fail very differently, and the quiet one is the reason
 * this gate is at the parse boundary. A fractional `1.5` is caught downstream by
 * the worker schema's `z.number().int()` — loud, and the payload is rejected. A
 * negative `-1` clears that same schema and syncs as a genuine hierarchy level,
 * putting a plausible-but-wrong depth in the database, which is worse than a
 * rejection. `0` is a real depth and is kept. The worker schema carries the
 * matching `.nonnegative()` so neither side alone is the only guard.
 */
function depthOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}
