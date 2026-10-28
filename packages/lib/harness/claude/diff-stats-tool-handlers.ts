/**
 * The diffStats-accumulating tool handlers extracted from `parse-claude.ts`.
 *
 * `Edit`, `Write`, and `MultiEdit` form one cohesive unit: each derives a
 * per-tool-use line delta and folds it into the session's aggregate diffStats
 * (added/removed line totals + the distinct-file set). Splitting them into this
 * sibling keeps `parse-claude.ts` shrinking rather than
 * growing (root AGENTS.md file-size rule) while the parser's tool-name registry
 * simply spreads this list in.
 *
 * The extraction was byte-identical to the previous inline handlers; changes
 * since are issue-scoped corrections, each with a `DATA_REVISION` entry
 * recording what it re-derives. Parser output here is PERSISTED, so any edit
 * that moves a delta needs that bump — and needs the layer-2 golden snapshots
 * checked rather than assumed immovable.
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
      // ISS-6737: no path, no delta. `diffFiles` was already guarded on a string
      // `file_path` while the totals were added unconditionally, so
      // `linesAdded`/`linesRemoved` moved while `filesChanged` did not — a delta
      // attributable to no file. One valid edit elsewhere in the same sidecar
      // keeps `diffStats` alive, and the pathless record's lines then fold into
      // the totals invisibly. Dropping it whole is what the module's contract
      // already says: partially counting a corrupt payload is the same
      // fabrication in a quieter form.
      if (typeof inp.file_path !== "string") {
        return;
      }
      const oldStr = typeof inp.old_string === "string" ? inp.old_string : null;
      const newStr = typeof inp.new_string === "string" ? inp.new_string : null;
      tu.diffDelta = computeLineDelta(oldStr, newStr);
      acc.totalAdded += tu.diffDelta.add;
      acc.totalRemoved += tu.diffDelta.del;
      acc.diffFiles.add(inp.file_path);
    },
  ],
  // CR-4 / FEA-1899 (AC-5): Compute diffDelta for Write tool uses.
  [
    "Write",
    (acc: DiffStatsAccumulator, tu: DiffDeltaTarget, toolInput: unknown) => {
      const inp = asRecord(toolInput);
      // ISS-6762: a `content` that is not a string tells us NOTHING about the
      // file — it neither reveals a new known state nor evidences a deletion.
      // The handler stays total anyway — ISS-6761 put the schema gate in front
      // of BOTH lanes, but these are exported and a direct caller reaches them
      // ungated — so such a record must only ever take the fresh-file path
      // below: it must not diff against the path's real baseline, nor replace
      // it.
      const writtenContent =
        typeof inp.content === "string" ? inp.content : null;
      // ISS-6737: same rule as Edit — a Write with no path booked its content as
      // added lines against no file (measured: 3 added, 0 files).
      if (typeof inp.file_path !== "string") {
        return;
      }
      const filePath = inp.file_path;
      // FEA-1899 (AC-5): if this path was Read earlier in the session the Write
      // is an overwrite — diff Read-vs-Write so deletions are counted. Without a
      // prior Read there is no baseline, and the SAME formula books every line
      // as added and nothing as removed.
      const priorRead =
        writtenContent === null
          ? undefined
          : acc.readContentByPath.get(filePath);
      tu.diffDelta = computeLineDelta(priorRead, writtenContent);
      acc.totalAdded += tu.diffDelta.add;
      acc.totalRemoved += tu.diffDelta.del;
      acc.diffFiles.add(filePath);
      // A Write makes its content the new known state for any later Write of
      // the same path in this session.
      //
      // ISS-6762: only a Write that actually CARRIES content does. Caching the
      // coerced `""` for a corrupt payload would erase the path's real
      // baseline, and the next genuine overwrite would then diff against an
      // empty file — every one of its deletions vanishing and its additions
      // over-counted, from one malformed record earlier in the session. Since
      // ISS-6761 both lanes' entry points refuse such a payload outright, but
      // the invariant is still enforced here, where both lanes share it —
      // these handlers are exported and total, so a direct caller must not be
      // able to poison the baseline either.
      if (writtenContent !== null) {
        acc.readContentByPath.set(filePath, writtenContent);
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
      // ISS-6737: same rule as Edit and Write.
      if (typeof inp.file_path !== "string") {
        return;
      }
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
      acc.diffFiles.add(inp.file_path);
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
 * (tamsinb review, PR #4531).
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
 * Returns whether the payload was actually counted. It gates on
 * {@link isUsableDiffStatsToolInput} first: a malformed block is dropped whole
 * rather than coerced into a fabricated delta.
 *
 * ISS-6761: the parent's registry dispatch (`TOOL_USE_HANDLERS`) applies that
 * same gate before running these handlers. It used to be described here as
 * running "on records the parser has already normalized", which was false — it
 * hands the handlers `block.input` straight off the parsed `.jsonl` line, with
 * no normalization of `content`/`old_string`/`edits` at all. Both lanes are fed
 * raw transcript JSON, so both gate: one formula, one answer for a corrupt
 * payload.
 *
 * The shared `Write` handler still holds its own narrower line (ISS-6762: a
 * payload carrying no content neither diffs against the path's overwrite
 * baseline nor replaces it). That is not made redundant by the gate — the
 * handlers are exported and total, so the invariant belongs where every caller
 * shares it rather than in each lane's entry point.
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
 * ISS-5426 (whitlockk review, PR #4715): run a tool use through the SAME registry
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
 * payload is still counted: a `Write` whose `content` is not a string becomes
 * `""`, and an `Edit` or `MultiEdit` carrying no string side yields a `{0, 0}`
 * delta — each contributing a changed FILE (and, before ISS-6764 rewrote the
 * fresh-Write branch, a phantom added line) off a record the formula cannot
 * actually read. That is believable-but-false diffStats.
 *
 * A record that fails its schema is dropped whole rather than counted in part:
 * partially counting a corrupt payload is the same fabrication in a quieter
 * form. Unknown keys are ignored (`replace_all`, `structuredPatch`, …) — this
 * validates the fields the formula reads, not the tool's whole surface.
 *
 * ISS-6737: `MultiEdit` is the ONE deliberate exception, and it is stated here
 * because the sentence above otherwise reads as contradicted by the code. Its
 * refine is `some`, not `every`, so a payload keeps its valid entries when one
 * entry carries neither string side. That is not partial counting of a corrupt
 * record: an entry with no string side yields `{0, 0}`, contributing nothing to
 * either total, so the alternative — `every`, discarding a large valid
 * MultiEdit over one empty entry — would DROP real lines rather than prevent
 * fabricated ones. The rule the contract protects is that nothing uncountable
 * is counted, and `some` satisfies it. If a future entry shape can contribute a
 * NON-zero delta while still failing to describe an edit, this choice has to be
 * revisited with it.
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
          // ISS-6737: required. A delta with no file is unattributable — the
          // totals moved while `filesChanged` did not.
          file_path: z.string(),
          old_string: z.string().optional(),
          new_string: z.string().optional(),
        })
        // One side may legitimately be absent — an insertion has no `old_string`
        // and a deletion no `new_string` — but neither side means no delta.
        .refine(
          (input) =>
            input.old_string !== undefined || input.new_string !== undefined
        ),
      Write: z.object({ file_path: z.string(), content: z.string() }),
      MultiEdit: z
        .object({
          file_path: z.string(),
          edits: z.array(MULTI_EDIT_ENTRY_SCHEMA).min(1),
        })
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
 * Callers that feed the formula UNVALIDATED transcript JSON must gate on this
 * before dispatching, so a malformed block drops out of both
 * `linesAdded/linesRemoved` and `filesChanged` instead of materializing a
 * plausible-but-wrong number. Since ISS-6761 that is BOTH lanes — the desktop
 * sidecar reads `tool_use.input` off the raw sub-agent `.jsonl`, and the parent
 * parser hands its registry `block.input` off the parsed line just as raw. A tool with no diffStats handler is not "unusable",
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
