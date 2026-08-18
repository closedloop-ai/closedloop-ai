/**
 * The diffStats-accumulating tool handlers extracted from `parse-claude.ts`.
 *
 * `Edit`, `Write`, and `MultiEdit` form one cohesive unit: each derives a
 * per-tool-use line delta and folds it into the session's aggregate diffStats
 * (added/removed line totals + the distinct-file set). Splitting them into this
 * sibling keeps the grandfathered `parse-claude.ts` shrinking rather than
 * growing (root AGENTS.md file-size rule) while the parser's tool-name registry
 * simply spreads this list in.
 *
 * Behavior is byte-identical to the previous inline handlers — the same
 * closures over the same accumulator fields — so parser output (and the golden
 * layer-2 snapshots) is unchanged.
 */

import { z } from "zod";
import { asRecord, computeLineDelta } from "../parser-utils";

/**
 * The subset of the parser's session accumulator these handlers mutate. The
 * full `SessionAccumulator` in `parse-claude.ts` is structurally assignable to
 * this, so the parser can register these handlers in its
 * `SessionAccumulator`-typed registry without widening its exported surface.
 */
export type DiffStatsAccumulator = {
  totalAdded: number;
  totalRemoved: number;
  readonly diffFiles: Set<string>;
  readonly readContentByPath: Map<string, string>;
};

/**
 * The only part of a `NormalizedToolUse` these handlers write. Narrowing the
 * handler parameter to this (rather than the full `NormalizedToolUse`) lets the
 * ISS-5402 sidecar lane run the SAME formula without fabricating a whole tool-use
 * record; the parser's real `NormalizedToolUse` is still structurally assignable,
 * so its registration is unchanged.
 */
export type DiffDeltaTarget = {
  diffDelta?: { add: number; del: number };
};

type DiffStatsToolHandler = (
  acc: DiffStatsAccumulator,
  tu: DiffDeltaTarget,
  toolInput: unknown
) => void;

/**
 * `[toolName, handler]` pairs for the tools that contribute to diffStats,
 * spread into the parser's `TOOL_USE_HANDLERS` map.
 *
 * ISS-5544: `as const` rather than a widening annotation, so the registered tool
 * names survive as literals and {@link DiffStatsToolName} can be derived from
 * them. That derivation is what makes the payload-schema map below fail `tsc`
 * on a registered handler it does not cover; the handler parameters are
 * therefore annotated explicitly, because `as const` supplies no contextual
 * type. `satisfies` still checks each entry against the handler contract.
 */
export const DIFF_STATS_TOOL_HANDLERS = [
  // CR-4: Compute diffDelta for Edit tool uses.
  [
    "Edit",
    (acc: DiffStatsAccumulator, tu: DiffDeltaTarget, toolInput: unknown) => {
      const inp = asRecord(toolInput);
      const oldStr = typeof inp.old_string === "string" ? inp.old_string : null;
      const newStr = typeof inp.new_string === "string" ? inp.new_string : null;
      tu.diffDelta = computeLineDelta(oldStr, newStr);
      acc.totalAdded += tu.diffDelta.add;
      acc.totalRemoved += tu.diffDelta.del;
      if (typeof inp.file_path === "string") {
        acc.diffFiles.add(inp.file_path);
      }
    },
  ],
  // CR-4 / FEA-1899 (AC-5): Compute diffDelta for Write tool uses.
  [
    "Write",
    (acc: DiffStatsAccumulator, tu: DiffDeltaTarget, toolInput: unknown) => {
      const inp = asRecord(toolInput);
      const fileContent = typeof inp.content === "string" ? inp.content : "";
      const filePath = typeof inp.file_path === "string" ? inp.file_path : null;
      // FEA-1899 (AC-5): if this path was Read earlier in the session the Write
      // is an overwrite — diff Read-vs-Write so deletions are counted. Without a
      // prior Read it is a fresh file (all added).
      const priorRead =
        filePath == null ? undefined : acc.readContentByPath.get(filePath);
      tu.diffDelta =
        priorRead === undefined
          ? { add: fileContent.split("\n").length, del: 0 }
          : computeLineDelta(priorRead, fileContent);
      acc.totalAdded += tu.diffDelta.add;
      acc.totalRemoved += tu.diffDelta.del;
      if (filePath != null) {
        acc.diffFiles.add(filePath);
        // A Write makes its content the new known state for any later Write of
        // the same path in this session.
        acc.readContentByPath.set(filePath, fileContent);
      }
    },
  ],
  // FEA-3942: MultiEdit applies several edits to ONE file in a single tool_use.
  // Mirror the Edit handler but sum every edit's line delta so its LOC is not
  // dropped; the file counts once toward filesChanged.
  [
    "MultiEdit",
    (acc: DiffStatsAccumulator, tu: DiffDeltaTarget, toolInput: unknown) => {
      const inp = asRecord(toolInput);
      const edits = Array.isArray(inp.edits) ? inp.edits : [];
      let add = 0;
      let del = 0;
      for (const edit of edits) {
        const e = asRecord(edit);
        const oldStr = typeof e.old_string === "string" ? e.old_string : null;
        const newStr = typeof e.new_string === "string" ? e.new_string : null;
        const delta = computeLineDelta(oldStr, newStr);
        add += delta.add;
        del += delta.del;
      }
      tu.diffDelta = { add, del };
      acc.totalAdded += add;
      acc.totalRemoved += del;
      if (typeof inp.file_path === "string") {
        acc.diffFiles.add(inp.file_path);
      }
    },
  ],
] as const satisfies ReadonlyArray<readonly [string, DiffStatsToolHandler]>;

/**
 * The name of a tool that has a diffStats handler, DERIVED from
 * {@link DIFF_STATS_TOOL_HANDLERS} (ISS-5544). Registering a fourth handler
 * widens this union, which is what makes the payload-schema table below fail
 * `tsc` until it covers the new tool.
 */
type DiffStatsToolName = (typeof DIFF_STATS_TOOL_HANDLERS)[number][0];

/**
 * ISS-5402: `Read` tool results whose content is cached as the overwrite
 * baseline strip Claude's `"<n>\t"` line-number prefixes back to the underlying
 * file text. Shared so the parser's main-file loop and the desktop sidecar lane
 * cannot drift on what a cached Read body looks like.
 */
const READ_LINE_NUMBER_PREFIX_RE = /^\s*\d+\t/;

/** Name-keyed view of {@link DIFF_STATS_TOOL_HANDLERS} for single-tool dispatch. */
const DIFF_STATS_TOOL_HANDLER_BY_NAME: ReadonlyMap<
  string,
  DiffStatsToolHandler
> = new Map(DIFF_STATS_TOOL_HANDLERS);

/**
 * The tool names that contribute a changed file path, DERIVED from
 * {@link DIFF_STATS_TOOL_HANDLERS} rather than re-declared beside it
 * (thadeusb review, PR #4531).
 *
 * The desktop sidecar lane recovers the parent's own changed-file paths with
 * this set so the parent/sidecar union can tell a genuinely new sidecar file
 * from one the parent already counted. A hand-maintained copy of these keys
 * drifts silently: a fourth registered handler would be missing from the set,
 * the parent's paths from that tool would fall out of the union, and every such
 * file would be double-counted as a new sidecar path. Deriving the set makes
 * that drift impossible rather than merely detectable.
 */
export const DIFF_STATS_TOOL_NAMES: ReadonlySet<string> = new Set(
  DIFF_STATS_TOOL_HANDLERS.map(([toolName]) => toolName)
);

/** A fresh, empty accumulator for one diffStats derivation pass. */
export function createDiffStatsAccumulator(): DiffStatsAccumulator {
  return {
    totalAdded: 0,
    totalRemoved: 0,
    diffFiles: new Set<string>(),
    readContentByPath: new Map<string, string>(),
  };
}

/**
 * ISS-5402: run one tool use through the diffStats formula, returning whether it
 * was a diffStats-contributing tool. This is the SSOT entry point for callers
 * outside the parser's tool-name registry — specifically the desktop Claude
 * sidecar lane, which folds a delegated sub-agent's `Edit`/`Write`/`MultiEdit`
 * lines up to the parent session (the roll-up-to-parent model ISS-5395 landed).
 * Routing it here rather than re-deriving line deltas at the call site is what
 * keeps the parent lane and the sidecar lane from inventing a second formula.
 *
 * Returns whether the payload was actually counted. Unlike the parent's registry
 * dispatch (`TOOL_USE_HANDLERS`, which runs the handlers directly on records the
 * parser has already normalized), this entry point is fed raw transcript JSON,
 * so it gates on {@link isUsableDiffStatsToolInput} first: a malformed block is
 * dropped whole rather than coerced into a fabricated delta. The parent lane's
 * behavior is deliberately unchanged — this is a guard on the new raw-input
 * caller, not a redefinition of the shared formula.
 */
export function applyDiffStatsToolUse(
  acc: DiffStatsAccumulator,
  toolName: string,
  toolInput: unknown
): boolean {
  const handler = DIFF_STATS_TOOL_HANDLER_BY_NAME.get(toolName);
  if (!(handler && isUsableDiffStatsToolInput(toolName, toolInput))) {
    return false;
  }
  handler(acc, {}, toolInput);
  return true;
}

/**
 * ISS-5426 (wongk review, PR #4715): run a tool use through the SAME registry
 * handler for its STATE transition only, discarding its line and changed-file
 * contribution.
 *
 * A caller that suppresses an already-counted tool use (the desktop sidecar
 * lane's `countedDiffToolUseIds` guard) must still let that record advance the
 * accumulator's known-file state, because the NEXT record's delta is measured
 * against it: `Write` makes its own content the baseline any later `Write` of
 * the same path diffs from. Skipping the handler outright leaves that path
 * looking never-written, so the next `Write` reads as a fresh all-added file and
 * overcounts by exactly the lines it did not change.
 *
 * The discard is structural rather than a subtract-after: the handler is given a
 * throwaway totals/`diffFiles` pair while SHARING the real `readContentByPath`
 * map. Any future handler that carries state through that map is therefore
 * covered here with no edit, and no caller has to know which accumulator fields
 * are "count" and which are "state".
 *
 * The same schema gate as {@link applyDiffStatsToolUse} applies: a malformed
 * payload advances no baseline either, so a corrupt `Write` cannot poison the
 * diff of the next real one.
 */
export function applyDiffStatsToolUseState(
  acc: DiffStatsAccumulator,
  toolName: string,
  toolInput: unknown
): void {
  const handler = DIFF_STATS_TOOL_HANDLER_BY_NAME.get(toolName);
  if (!(handler && isUsableDiffStatsToolInput(toolName, toolInput))) {
    return;
  }
  handler(
    {
      totalAdded: 0,
      totalRemoved: 0,
      diffFiles: new Set<string>(),
      readContentByPath: acc.readContentByPath,
    },
    {},
    toolInput
  );
}

/**
 * ISS-5402: cache a successful `Read` result as the overwrite baseline for a
 * later `Write` of the same path (FEA-1899 AC-5). A partial read (`offset` or
 * `limit`) returns only a slice, so it is deliberately NOT cached — diffing a
 * later Write against a slice would fabricate deletions.
 *
 * Extracted from the parser's inline tool-result branch so the sidecar lane
 * reproduces the same overwrite semantics instead of counting every delegated
 * `Write` as an all-added fresh file.
 */
export function captureDiffStatsReadResult(
  acc: DiffStatsAccumulator,
  toolInput: unknown,
  resultText: string
): void {
  const readInput = asRecord(toolInput);
  const isPartialRead = readInput.offset != null || readInput.limit != null;
  if (typeof readInput.file_path !== "string" || isPartialRead) {
    return;
  }
  acc.readContentByPath.set(
    readInput.file_path,
    resultText
      .split("\n")
      .map((line) => line.replace(READ_LINE_NUMBER_PREFIX_RE, ""))
      .join("\n")
  );
}

/** One `MultiEdit` entry: usable when it carries at least one edited side. */
const MULTI_EDIT_ENTRY_SCHEMA = z.object({
  old_string: z.string().optional(),
  new_string: z.string().optional(),
});

/**
 * ISS-5402: the payload shapes that can yield a TRUSTWORTHY line delta, keyed by
 * tool name.
 *
 * The handlers above are deliberately total — they coerce a missing or
 * non-string field to a default so a single odd record never aborts a parse. On
 * a well-formed transcript that is the right posture, but it means a corrupt
 * payload still produces a number: a `Write` whose `content` is not a string
 * becomes `""`, and `"".split("\n").length` books ONE added line that nobody
 * wrote; an `Edit` or `MultiEdit` carrying no string side yields a `{0, 0}`
 * delta while still claiming a changed file. Both are believable-but-false LOC.
 *
 * A record that fails its schema is dropped whole rather than counted in part:
 * partially counting a corrupt payload is the same fabrication in a quieter
 * form. Unknown keys are ignored (`replace_all`, `structuredPatch`, …) — this
 * validates the fields the formula reads, not the tool's whole surface.
 *
 * ISS-5544: the keys are a keys-covered `Record<DiffStatsToolName, …>` over the
 * handler registry rather than a hand-written list, because
 * {@link isUsableDiffStatsToolInput} fails OPEN on a missing entry — a fourth
 * registered handler with no schema here would silently ungate the guard for the
 * raw-input sidecar lane it exists to protect. A registered handler with no
 * schema (or a schema for an unregistered tool) is now a `tsc` failure. It is
 * still read through a `Map`, so a tool name off a raw transcript cannot reach
 * `__proto__` or `constructor` on the object literal.
 */
const DIFF_STATS_TOOL_INPUT_SCHEMA_BY_NAME: ReadonlyMap<string, z.ZodType> =
  new Map(
    Object.entries({
      Edit: z
        .object({
          old_string: z.string().optional(),
          new_string: z.string().optional(),
        })
        // One side may legitimately be absent — an insertion has no `old_string`
        // and a deletion no `new_string` — but neither side means no delta.
        .refine(
          (input) =>
            input.old_string !== undefined || input.new_string !== undefined
        ),
      Write: z.object({ content: z.string() }),
      MultiEdit: z
        .object({ edits: z.array(MULTI_EDIT_ENTRY_SCHEMA).min(1) })
        .refine((input) =>
          input.edits.some(
            (edit) =>
              edit.old_string !== undefined || edit.new_string !== undefined
          )
        ),
    } satisfies Record<DiffStatsToolName, z.ZodType>)
  );

/**
 * ISS-5402: whether a raw tool payload can produce a line delta worth counting.
 *
 * Callers that feed the formula UNVALIDATED transcript JSON — the desktop
 * sidecar lane reads `tool_use.input` straight off the raw sub-agent `.jsonl` —
 * must gate on this before dispatching, so a malformed block drops out of both
 * `linesAdded/linesRemoved` and `filesChanged` instead of materializing a
 * plausible-but-wrong number. A tool with no diffStats handler is not "unusable",
 * it is simply not a diffStats tool, so it returns `true` here and is filtered by
 * the handler lookup instead. Since ISS-5544 that is the ONLY tool this can
 * return `true` unchecked for: every registered handler is guaranteed a schema
 * at compile time, so a diffStats tool can no longer reach this fail-open path.
 */
export function isUsableDiffStatsToolInput(
  toolName: string,
  toolInput: unknown
): boolean {
  const schema = DIFF_STATS_TOOL_INPUT_SCHEMA_BY_NAME.get(toolName);
  if (!schema) {
    return true;
  }
  return schema.safeParse(asRecord(toolInput)).success;
}
