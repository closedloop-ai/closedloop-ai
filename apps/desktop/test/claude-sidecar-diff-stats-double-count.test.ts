/**
 * @file claude-sidecar-diff-stats-double-count.test.ts
 * @description ISS-5426 — the ISS-5402 sidecar `diffStats` fold counts a
 * sub-agent's authored lines EXACTLY ONCE.
 *
 * ISS-5402 folded a delegated sub-agent's `Edit`/`Write`/`MultiEdit` lines up
 * into the parent's aggregate `diffStats`. That fold had two latent
 * double-count paths, neither reachable in the frozen golden corpus and so
 * neither covered until now:
 *
 *  1. A sub-agent can be represented TWICE — as `isSidechain: true` entries
 *     inside the parent `.jsonl` (which the core parser already runs through
 *     `TOOL_USE_HANDLERS`, so their lines already count) and as its own
 *     `subagents/agent-*.jsonl` sidecar (which the fold also counts). The
 *     codebase already believes this overlap occurs: the sidecar merge in
 *     `claude-parser.ts` reuses an in-line sidechain subagent record for a
 *     sidecar file and dedups `subagent.toolUses` by `toolUse.id`. The line
 *     fold had no equivalent guard.
 *  2. `parse-claude.ts` drops resume/compaction-replayed entries by `uuid`
 *     BEFORE any accumulation (FEA-3453) precisely so aggregates cannot
 *     double-count them. The desktop sidecar lane skipped that filter.
 *
 * These are two independent mechanisms, asserted independently: the first is
 * keyed on `tool_use.id` against the parent's own counted set, the second on
 * `uuid` within one sidecar file. Neither test pins the pre-fix numbers.
 *
 * PR #4715 review (codex + wongk, independently) found the first version of this
 * dedup only HALF closed, and the suite passing anyway because it asserted only
 * the metric each fix moved. Four more properties are pinned here, each with a
 * positive control proving the branch is actually reached:
 *
 *  3. The same dual representation the LOC fold suppresses was still folded a
 *     second time by `mergeFoldedUsage` — LOC counted once, COST counted twice.
 *     Every dual-representation case therefore asserts TOKEN TOTALS, not just
 *     `diffStats`; that is the assertion whose absence let the defect hide.
 *  4. Suppressing an already-counted tool use must not suppress its STATE: a
 *     duplicated `Write` still has to advance the overwrite baseline the next
 *     `Write` to that path diffs against.
 *  5. The parent's counted-id seed must not claim an id for a MALFORMED inline
 *     record, or a truncated inline copy deletes the sidecar's valid one.
 *  6. The uuid replay filter has to cover the tool-use extraction as well as the
 *     token/diffStats accumulation, because an IDLESS replayed tool use is
 *     invisible to the caller's `tool_use.id` dedup.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";
import {
  assistantLine,
  DELEGATING_ONLY_PARENT,
  editBlock,
  INPUT_TOKENS_PER_TURN,
  MODEL,
  malformedEditBlock,
  OPENING_USER_LINE,
  OUTPUT_TOKENS_PER_TURN,
  parentTurn,
  skillBlock,
  writeBlock,
} from "./sidecar-diff-stats-fixtures.js";

/** One `editBlock` contributes exactly this delta over exactly one file. */
const ONE_EDIT_DIFF_STATS = {
  filesChanged: 1,
  linesAdded: 2,
  linesRemoved: 1,
};

type BilledUsage = { input: number; output: number; turns: number };

/**
 * What the session actually billed, as one comparable triple.
 *
 * `tokenSeries` rides alongside `tokensByModel` because they are two separate
 * accumulations inside `mergeFoldedUsage` — a dedup applied to only the totals
 * would leave the per-turn series, and everything derived from it, still
 * double-counted.
 */
function billedUsage(parsed: {
  tokensByModel: Record<string, { input: number; output: number }>;
  tokenSeries: unknown[];
}): BilledUsage {
  return {
    input: parsed.tokensByModel[MODEL]?.input ?? 0,
    output: parsed.tokensByModel[MODEL]?.output ?? 0,
    turns: parsed.tokenSeries.length,
  };
}

/**
 * What `turns` folded assistant round-trips must bill. Expressed as a turn count
 * rather than raw numbers because that is the property under test: one API
 * round-trip, one bill, no matter how many transcripts wrote it down.
 */
function billedFor(turns: number): BilledUsage {
  return {
    input: INPUT_TOKENS_PER_TURN * turns,
    output: OUTPUT_TOKENS_PER_TURN * turns,
    turns,
  };
}

test("ISS-5426: a sub-agent present BOTH inline and as a sidecar contributes its lines once", async () => {
  // The dual representation, built deliberately: `agentId: "lane"` normalizes
  // to the subagent id `agent-lane`, which is exactly the identity the sidecar
  // file `agent-lane.jsonl` folds under — so this is ONE sub-agent written down
  // twice, not two sub-agents. The single authored edit carries one
  // `tool_use.id` in both places, which is the identity the dedup keys on.
  const sharedEdit = editBlock("toolu_dual_represented", "/repo/src/dual.ts");
  const subagentLine = assistantLine(
    "sub-u1",
    "req_sub",
    "msg_sub",
    [sharedEdit],
    { isSidechain: true, agentId: "lane" }
  );

  const filePath = writeClaudeTranscript(
    "sess-dual-representation",
    [...DELEGATING_ONLY_PARENT, subagentLine],
    { subagents: { lane: [subagentLine] } }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // The core already counted this edit off the parent's inline sidechain entry.
  // The sidecar fold must not count it again: one edit happened, so the session
  // authored 2 added / 1 removed over 1 file — not double that.
  assert.deepEqual(parsed.diffStats, ONE_EDIT_DIFF_STATS);

  // codex + wongk review (PR #4715): and the COST side of the same turn must
  // dedup on the same identity. Two round-trips happened here — the parent's own
  // turn and the sub-agent's — so the session bills two, not the three it billed
  // while `mergeFoldedUsage` re-folded a turn the core had already booked. This
  // is the assertion whose absence let LOC read once and cost read twice from a
  // fixture that looked green.
  assert.deepEqual(billedUsage(parsed), billedFor(2));
});

test("ISS-5426: a sub-agent's dual representation still bills its OWN row in full", async () => {
  // The positive control for the cost dedup: the parent-level suppression must
  // come from "the parent already billed it", NOT from dropping the sub-agent's
  // work. The sub-agent row keeps its full usage — that round-trip is genuinely
  // its work, wherever it was written down — so a reader breaking the session
  // down per agent still sees it.
  const sharedEdit = editBlock("toolu_row_intact", "/repo/src/row.ts");
  const subagentLine = assistantLine(
    "sub-u1",
    "req_sub",
    "msg_sub",
    [sharedEdit],
    { isSidechain: true, agentId: "lane" }
  );

  const filePath = writeClaudeTranscript(
    "sess-dual-subagent-row",
    [...DELEGATING_ONLY_PARENT, subagentLine],
    { subagents: { lane: [subagentLine] } }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(billedUsage(parsed), billedFor(2));

  const subagent = (parsed.subagents ?? []).find((s) => s.id === "agent-lane");
  assert.ok(subagent, "the sidecar must still produce a sub-agent row");
  assert.equal(
    subagent.tokensByModel?.[MODEL]?.output,
    OUTPUT_TOKENS_PER_TURN,
    "the sub-agent's own row keeps the round-trip it performed"
  );
});

test("ISS-5426: a sub-agent that exists ONLY as a sidecar is still fully counted", async () => {
  // The guard above must not become a blanket suppression: with no inline
  // sidechain twin there is nothing to dedup against, and ISS-5402's roll-up
  // has to keep working. This is the branch that fails if the exclusion set is
  // seeded from the wrong population (e.g. the sidecar's own ids).
  const filePath = writeClaudeTranscript(
    "sess-sidecar-only",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(
            "sub-u1",
            "req_sub",
            "msg_sub",
            [editBlock("toolu_sidecar_only", "/repo/src/only-sidecar.ts")],
            { isSidechain: true, agentId: "lane" }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.diffStats, ONE_EDIT_DIFF_STATS);
  // The cost-side falsifier for the same guard: with no inline twin there is
  // nothing already billed, so the sidecar's round-trip must still be folded.
  // A parent-keyed usage dedup that over-suppressed would show one turn here.
  assert.deepEqual(billedUsage(parsed), billedFor(2));
});

test("ISS-5426: a parent's own inline edit never suppresses a DIFFERENT sidecar edit", async () => {
  // Identity is the tool use, not the file: two genuinely distinct edits to the
  // same path — one by the parent, one by a sub-agent — both count their lines,
  // and the path still counts as one changed file (the ISS-5402 union).
  const sharedPath = "/repo/src/shared.ts";
  const filePath = writeClaudeTranscript(
    "sess-distinct-ids-same-file",
    [OPENING_USER_LINE, parentTurn([editBlock("toolu_parent", sharedPath)])],
    {
      subagents: {
        lane: [
          assistantLine(
            "sub-u1",
            "req_sub",
            "msg_sub",
            [editBlock("toolu_sub", sharedPath)],
            { isSidechain: true, agentId: "lane" }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 1,
    linesAdded: 4,
    linesRemoved: 2,
  });
});

test("ISS-5426: one record carried by TWO sidecar files contributes its lines once", async () => {
  // The FEA-3420 nested shape: a workflow agent's records can appear inside its
  // parent sidecar's transcript AND in its own `agent-*.jsonl`. NEITHER file is
  // parsed by the core, so neither is in `session.toolUses` — the parent seed
  // alone cannot see this. It is caught because each sidecar pass ADDS what it
  // counts to the one parent-scoped set.
  const sharedEdit = editBlock("toolu_carried_twice", "/repo/src/nested.ts");

  const filePath = writeClaudeTranscript(
    "sess-cross-sidecar-duplicate",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        outer: [
          assistantLine("outer-u1", "req_outer", "msg_outer", [sharedEdit], {
            isSidechain: true,
            agentId: "inner",
          }),
        ],
        inner: [
          assistantLine("inner-u1", "req_inner", "msg_inner", [sharedEdit], {
            isSidechain: true,
            agentId: "inner",
          }),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.diffStats, ONE_EDIT_DIFF_STATS);
  // These are two DISTINCT round-trips (`msg_outer` / `msg_inner`) that happen
  // to carry the same authored tool use, so the LINE dedup fires while the COST
  // dedup must not: three turns billed. The pair pins that the two folds key on
  // their own identities and neither borrows the other's.
  assert.deepEqual(billedUsage(parsed), billedFor(3));
});

test("ISS-5426: a replayed sidecar line with NO tool_use id still contributes once", async () => {
  // `tool_use.id` is raw transcript JSON, so its presence is not type-guaranteed
  // at this parse boundary. A record without one cannot be id-deduped at all —
  // this case is reachable ONLY by the uuid replay filter, which is why it is
  // asserted separately from the id-keyed cases above.
  //
  // wongk review (PR #4715): `diffStats` alone was NOT enough to prove this. The
  // parser then read each sidecar TWICE — once through `collectEntriesFromFile`
  // (which runs the uuid filter, hence the correct `diffStats`) and once through
  // `scanSubagentTranscriptStream`, which had no filter and whose caller can
  // only dedup on `tool_use.id`. An IDLESS replayed tool use slipped straight
  // through that second pass, so the merged records and every downstream
  // projection of them still carried the duplicate this fixture was written to
  // exclude. ISS-5542 has since folded the extraction into the filtered pass and
  // deleted the second read, but the tool-use and skill assertions below remain
  // what make the fixture check the duplication rather than one metric that
  // happens to be protected.
  const idlessEdit = {
    type: "tool_use",
    name: "Edit",
    input: {
      file_path: "/repo/src/idless.ts",
      old_string: "alpha",
      new_string: "beta\ngamma",
    },
  };
  const replayedLine = assistantLine(
    "sub-idless-uuid",
    "req_sub",
    "msg_sub",
    [idlessEdit, skillBlock(undefined, "idless-skill")],
    { isSidechain: true, agentId: "lane" }
  );

  const filePath = writeClaudeTranscript(
    "sess-replayed-idless",
    DELEGATING_ONLY_PARENT,
    { subagents: { lane: [replayedLine, replayedLine] } }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.diffStats, ONE_EDIT_DIFF_STATS);

  const subagent = (parsed.subagents ?? []).find((s) => s.id === "agent-lane");
  assert.ok(subagent, "the sidecar must produce a sub-agent row");
  assert.deepEqual(
    (subagent.toolUses ?? []).map((toolUse) => toolUse.name),
    ["Edit", "Skill"],
    "a replayed idless tool use must be merged once, not once per replay"
  );
  // The downstream projection the duplicate actually reached: `session.skills`
  // is derived from the merged sub-agent tool uses, so a duplicated idless
  // `Skill` was reported as two invocations of a skill used once.
  assert.deepEqual(
    parsed.skills.map((skill) => skill.name),
    ["idless-skill"]
  );
});

test("ISS-5426: two DISTINCT idless sidecar tool uses are both merged", async () => {
  // The positive control for the filter above: it keys on the ENTRY `uuid`, so
  // distinct lines must both survive even though neither tool use has an id to
  // be told apart by. Without this, "no duplicates" would also be satisfied by a
  // filter that dropped every idless record after the first.
  const filePath = writeClaudeTranscript(
    "sess-distinct-idless",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(
            "sub-idless-a",
            "req_a",
            "msg_a",
            [skillBlock(undefined, "first-skill")],
            { isSidechain: true, agentId: "lane" }
          ),
          assistantLine(
            "sub-idless-b",
            "req_b",
            "msg_b",
            [skillBlock(undefined, "second-skill")],
            { isSidechain: true, agentId: "lane" }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.skills.map((skill) => skill.name),
    ["first-skill", "second-skill"]
  );
  assert.deepEqual(billedUsage(parsed), billedFor(3));
});

test("ISS-5426: a duplicated Write still advances the baseline the NEXT Write diffs from", async () => {
  // wongk review (PR #4715): the dedup suppresses the COUNT; it must not
  // suppress the STATE. `Write` makes its own content the known state of that
  // path, and the next `Write` to it is diffed against exactly that. Returning
  // early on an already-counted record left the path looking never-written, so
  // the following genuine `Write` was scored as a fresh all-added file.
  const target = "/repo/src/state.ts";
  const duplicatedWrite = assistantLine(
    "sub-u1",
    "req_sub_1",
    "msg_sub_1",
    [writeBlock("toolu_w1", target, "one\ntwo\nthree")],
    { isSidechain: true, agentId: "lane" }
  );
  const followUpWrite = assistantLine(
    "sub-u2",
    "req_sub_2",
    "msg_sub_2",
    [writeBlock("toolu_w2", target, "one\ntwo")],
    { isSidechain: true, agentId: "lane" }
  );

  const filePath = writeClaudeTranscript(
    "sess-duplicated-write-baseline",
    [...DELEGATING_ONLY_PARENT, duplicatedWrite],
    { subagents: { lane: [duplicatedWrite, followUpWrite] } }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // The first Write authored 3 lines (counted once, by the core, off the inline
  // copy). The second deleted the third line and added nothing: measured against
  // the correct baseline that is `{ add: 0, del: 1 }`. Measured against a stale
  // never-written baseline it would have been `{ add: 2, del: 0 }` — i.e.
  // `{ linesAdded: 5, linesRemoved: 0 }` for the session, two lines nobody wrote
  // and a deletion that vanished.
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 1,
    linesAdded: 3,
    linesRemoved: 1,
  });
  assert.deepEqual(billedUsage(parsed), billedFor(3));
});

test("ISS-5426: a MALFORMED inline record never suppresses the sidecar's valid copy", async () => {
  // wongk review (PR #4715): the parent's counted-id seed used to key on the
  // TOOL NAME alone, on the reasoning that the parent's handlers are total so a
  // registered name is always "already counted". Total is not the same as
  // trustworthy: a truncated inline `Edit` carrying no edited side is coerced
  // into a `{0, 0}` delta, and seeding its id then DELETED the sidecar's
  // well-formed copy of the same tool use — data loss in the opposite direction
  // from the double-count the seed exists to prevent.
  //
  // Same `tool_use.id` in both places on purpose: this is one authored edit,
  // written down once corrupt and once intact.
  const sharedId = "toolu_recovered";
  const target = "/repo/src/recovered.ts";
  const corruptInline = assistantLine(
    "sub-u1",
    "req_sub_1",
    "msg_sub_1",
    [malformedEditBlock(sharedId, target)],
    { isSidechain: true, agentId: "lane" }
  );
  const intactSidecar = assistantLine(
    "sub-u2",
    "req_sub_2",
    "msg_sub_2",
    [editBlock(sharedId, target)],
    { isSidechain: true, agentId: "lane" }
  );

  const filePath = writeClaudeTranscript(
    "sess-malformed-inline-claim",
    [...DELEGATING_ONLY_PARENT, corruptInline],
    { subagents: { lane: [intactSidecar] } }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // The real delta survives. Under the name-only seed this read
  // `{ filesChanged: 1, linesAdded: 0, linesRemoved: 0 }` — the corrupt copy's
  // empty delta presented as the measurement.
  assert.deepEqual(parsed.diffStats, ONE_EDIT_DIFF_STATS);
});

test("ISS-5426: a WELL-FORMED inline record does still suppress the sidecar copy", async () => {
  // The positive control for the seed gate: relaxing it must not turn the guard
  // off. Identical fixture to the case above with an intact inline copy — the
  // seed claims the id, and the duplicate folds once on both LOC and cost.
  const sharedId = "toolu_intact_both";
  const target = "/repo/src/intact.ts";
  const intactInline = assistantLine(
    "sub-u1",
    "req_sub_1",
    "msg_sub_1",
    [editBlock(sharedId, target)],
    { isSidechain: true, agentId: "lane" }
  );
  const intactSidecar = assistantLine(
    "sub-u2",
    "req_sub_2",
    "msg_sub_2",
    [editBlock(sharedId, target)],
    { isSidechain: true, agentId: "lane" }
  );

  const filePath = writeClaudeTranscript(
    "sess-intact-inline-claim",
    [...DELEGATING_ONLY_PARENT, intactInline],
    { subagents: { lane: [intactSidecar] } }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.diffStats, ONE_EDIT_DIFF_STATS);
});

test("ISS-5426: a resume/compaction-replayed sidecar line contributes its edit once", async () => {
  // FEA-3453: on resume/compaction Claude Code re-writes earlier entries
  // VERBATIM — same `uuid`, same `timestamp` — into the continued log. The
  // parent lane drops them by `uuid` before any accumulation; the sidecar lane
  // must too, or a replayed sub-agent edit books its lines twice.
  const replayedLine = assistantLine(
    "sub-replayed-uuid",
    "req_sub",
    "msg_sub",
    [editBlock("toolu_replayed", "/repo/src/replayed.ts")],
    { isSidechain: true, agentId: "lane" }
  );

  const filePath = writeClaudeTranscript(
    "sess-replayed-sidecar-line",
    DELEGATING_ONLY_PARENT,
    { subagents: { lane: [replayedLine, replayedLine] } }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.diffStats, ONE_EDIT_DIFF_STATS);
});

test("ISS-5426: two DISTINCT sidecar lines are both counted, uuid dedup notwithstanding", async () => {
  // The falsifier for the uuid filter: distinct `uuid`s must both survive it, so
  // the dedup cannot be a blanket "count the first line only". Two real edits by
  // one sub-agent sum, exactly as ISS-5402 established.
  const filePath = writeClaudeTranscript(
    "sess-distinct-sidecar-lines",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(
            "sub-u1",
            "req_sub_1",
            "msg_sub_1",
            [editBlock("toolu_first", "/repo/src/first.ts")],
            { isSidechain: true, agentId: "lane" }
          ),
          assistantLine(
            "sub-u2",
            "req_sub_2",
            "msg_sub_2",
            [editBlock("toolu_second", "/repo/src/second.ts")],
            { isSidechain: true, agentId: "lane" }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 2,
    linesAdded: 4,
    linesRemoved: 2,
  });
  // And the token fold — the denominator half of `LOC / $` — still sees both
  // turns, so the uuid filter did not quietly drop a billable round-trip.
  assert.equal(parsed.tokensByModel[MODEL]?.output, 150);
});
