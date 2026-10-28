/**
 * @file parse-claude-worktree-session-kind.test.ts
 * @description ISS-7258 M4/M5: the distinct worktree entries a session worked
 * in, and the background-session marker.
 *
 * Both are stored for COMPLETENESS and nothing derives from them (D1/D3), so
 * what these cases pin is the shape and the omission contract, not a
 * downstream behavior there isn't one of.
 */
import { describe, expect, it } from "vitest";
import { MAX_HARNESS_SHORT_TEXT_CHARS } from "../parser-utils";
import type { NormalizedWorktreeEntry } from "../types";
import { parseClaudeTranscript } from "./parse-claude";

const CREATED = {
  worktreePath: "/repo/.claude/worktrees/w1",
  worktreeName: "w1",
  worktreeBranch: "worktree-w1",
  originalCwd: "/repo",
  preEnterOriginalCwd: "/repo",
  originalBranch: "main",
  originalHeadCommit: "2f941c266adf39c4aa61e92807ef796ef6fae89d",
  sessionId: "s",
};

const ENTERED = {
  worktreePath: "/repo/.claude/worktrees/w2",
  worktreeName: "w2",
  worktreeBranch: "worktree-w2",
  originalCwd: "/repo/.claude/worktrees/w1",
  preEnterOriginalCwd: "/repo",
  enteredExisting: true,
  sessionId: "s",
};

let lineCounter = 0;

function worktreeLine(worktreeSession: Record<string, unknown>): string {
  lineCounter += 1;
  return JSON.stringify({
    type: "worktree-state",
    uuid: `wt-${lineCounter}`,
    sessionId: "s",
    worktreeSession,
  });
}

function userLine(fields: Record<string, unknown> = {}): string {
  lineCounter += 1;
  return JSON.stringify({
    type: "user",
    uuid: `u-${lineCounter}`,
    timestamp: "2026-07-09T12:00:00.000Z",
    message: { role: "user", content: "go" },
    ...fields,
  });
}

async function parse(lines: string[]) {
  return await parseClaudeTranscript(lines, { sessionId: "s" });
}

describe("worktree entries (ISS-7258 M4)", () => {
  it("keeps both shapes, each with only its own fields", async () => {
    const session = await parse([
      worktreeLine(CREATED),
      worktreeLine(ENTERED),
      userLine(),
    ]);

    expect(session?.worktreeEntries).toEqual([
      {
        worktreePath: "/repo/.claude/worktrees/w1",
        worktreeName: "w1",
        worktreeBranch: "worktree-w1",
        originalCwd: "/repo",
        preEnterOriginalCwd: "/repo",
        originalBranch: "main",
        originalHeadCommit: "2f941c266adf39c4aa61e92807ef796ef6fae89d",
      },
      {
        worktreePath: "/repo/.claude/worktrees/w2",
        worktreeName: "w2",
        worktreeBranch: "worktree-w2",
        originalCwd: "/repo/.claude/worktrees/w1",
        preEnterOriginalCwd: "/repo",
        enteredExisting: true,
      },
    ]);
  });

  it("collapses the harness's rewritten copies to the distinct set", async () => {
    // The record is REWRITTEN on every change rather than appended; one real
    // session holds 652 copies. Without content-keyed dedup the stored list is
    // a transcript-length artifact, not an answer.
    const session = await parse([
      worktreeLine(CREATED),
      worktreeLine(CREATED),
      worktreeLine(CREATED),
      worktreeLine(ENTERED),
      worktreeLine(CREATED),
      userLine(),
    ]);

    expect(session?.worktreeEntries).toHaveLength(2);
  });

  it("keeps two entries that differ only by base branch", async () => {
    // The one-to-many case D1 turns on: same worktree path, different base. A
    // path-keyed dedup would silently drop one and make a scalar column look
    // sufficient.
    const session = await parse([
      worktreeLine(CREATED),
      worktreeLine({ ...CREATED, originalBranch: "release" }),
      userLine(),
    ]);

    expect(
      session?.worktreeEntries?.map(
        (entry) => (entry as { originalBranch?: string }).originalBranch
      )
    ).toEqual(["main", "release"]);
  });

  it("drops a half-formed entry rather than storing it", async () => {
    const session = await parse([
      // Missing a required common string.
      worktreeLine({ ...CREATED, worktreeBranch: undefined }),
      // Neither shape: no base pair, and not marked as entered.
      worktreeLine({
        ...CREATED,
        originalBranch: undefined,
        originalHeadCommit: undefined,
      }),
      // `enteredExisting` is only ever true; anything else is not that shape.
      worktreeLine({ ...ENTERED, enteredExisting: "yes" }),
      userLine(),
    ]);

    expect(session?.worktreeEntries).toBeUndefined();
  });

  it("omits the key entirely when the session worked in no worktree", async () => {
    const session = await parse([userLine()]);

    expect(session).not.toHaveProperty("worktreeEntries");
  });

  it("is a union, so a created entry never claims enteredExisting", async () => {
    const session = await parse([worktreeLine(CREATED), userLine()]);
    expect(session).toBeDefined();
    const [entry] = (session as { worktreeEntries: NormalizedWorktreeEntry[] })
      .worktreeEntries;

    expect(entry).not.toHaveProperty("enteredExisting");
    // The absence IS the signal that this worktree was created, not entered.
    expect(entry).toHaveProperty("originalBranch", "main");
  });
});

describe("reasoning effort (ISS-7258 M3)", () => {
  function assistantLine(fields: Record<string, unknown> = {}): string {
    lineCounter += 1;
    return JSON.stringify({
      type: "assistant",
      uuid: `a-${lineCounter}`,
      timestamp: "2026-07-09T12:00:00.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      ...fields,
    });
  }

  it("collects the distinct tiers the session's turns ran at", async () => {
    // It rides the RECORD, not `message.usage` like its usageExtras siblings.
    const session = await parse([
      assistantLine({ effort: "xhigh" }),
      assistantLine({ effort: "xhigh" }),
      assistantLine({ effort: "medium" }),
    ]);

    expect(session?.usageExtras.efforts).toEqual(["xhigh", "medium"]);
  });

  it("omits the key when no turn stated a tier", async () => {
    // Load-bearing: a default `[]` would add a line to all 31 frozen
    // normalized.json oracle files for a fact 28 of them never state.
    const session = await parse([assistantLine()]);

    expect(session?.usageExtras).not.toHaveProperty("efforts");
  });

  it("ignores a tier that is not a usable string", async () => {
    const session = await parse([
      assistantLine({ effort: "" }),
      assistantLine({ effort: 3 }),
    ]);

    expect(session?.usageExtras).not.toHaveProperty("efforts");
  });
});

describe("sessionKind (ISS-7258 M5)", () => {
  it("reads the marker off whichever record kind states it", async () => {
    // Measured on attachment / user / assistant / system alike, which is why it
    // is a session attribute rather than one handler's business.
    const session = await parse([
      userLine(),
      JSON.stringify({
        type: "system",
        uuid: "sys-1",
        subtype: "info",
        sessionKind: "bg",
      }),
    ]);

    expect(session?.sessionKind).toBe("bg");
  });

  it("is first-wins, like every other session-level attribute", async () => {
    const session = await parse([
      userLine({ sessionKind: "bg" }),
      userLine({ sessionKind: "interactive" }),
    ]);

    expect(session?.sessionKind).toBe("bg");
  });

  it("omits the key entirely when no record states it", async () => {
    const session = await parse([userLine()]);

    expect(session).not.toHaveProperty("sessionKind");
  });

  it("refuses a bridge-session record as the source of the kind", async () => {
    // PR #6418 review. `bridge-session` is deliberately undecoded by the parser
    // — it carries third-party account and organization UUIDs — so it must not
    // become the first-wins source of a session-level fact either. A later
    // ordinary record still supplies one.
    const session = await parse([
      JSON.stringify({
        type: "bridge-session",
        uuid: "b-1",
        timestamp: "2026-07-09T11:59:00.000Z",
        sessionKind: "bridge",
      }),
      userLine({ sessionKind: "bg" }),
    ]);

    expect(session?.sessionKind).toBe("bg");
  });

  it("omits the kind when only a bridge-session record states one", async () => {
    const session = await parse([
      JSON.stringify({
        type: "bridge-session",
        uuid: "b-2",
        timestamp: "2026-07-09T11:59:00.000Z",
        sessionKind: "bridge",
      }),
      userLine(),
    ]);

    expect(session).not.toHaveProperty("sessionKind");
  });

  // ISS-10593: the bridge-session pair above, applied to a second undecoded
  // type. These fail if the carve-out ever narrows to naming one member.
  it("refuses an artifact-autoreact-ledger record as the source of the kind", async () => {
    const session = await parse([
      JSON.stringify({
        type: "artifact-autoreact-ledger",
        uuid: "l-1",
        timestamp: "2026-07-09T11:59:00.000Z",
        sessionKind: "ledger",
      }),
      userLine({ sessionKind: "bg" }),
    ]);

    expect(session?.sessionKind).toBe("bg");
  });

  it("omits the kind when only an artifact-autoreact-ledger record states one", async () => {
    const session = await parse([
      JSON.stringify({
        type: "artifact-autoreact-ledger",
        uuid: "l-2",
        timestamp: "2026-07-09T11:59:00.000Z",
        sessionKind: "ledger",
      }),
      userLine(),
    ]);

    expect(session).not.toHaveProperty("sessionKind");
  });
});

describe("over-cap short strings are omitted at parse time (PR #6418 review)", () => {
  // The worker boundary is `.strict()`, so ONE over-cap string rejects the whole
  // response and re-drops the source on every retry. Each case here proves the
  // value is dropped at the source instead — the field, or the whole entry when
  // the entry cannot be valid without it.
  const overCap = "x".repeat(MAX_HARNESS_SHORT_TEXT_CHARS + 1);
  const atCap = "y".repeat(MAX_HARNESS_SHORT_TEXT_CHARS);

  it("drops an over-cap sessionKind but keeps one exactly at the cap", async () => {
    expect(
      await parse([userLine({ sessionKind: overCap })]).then(
        (s) => s?.sessionKind
      )
    ).toBeUndefined();

    const kept = await parse([userLine({ sessionKind: atCap })]);
    expect(kept?.sessionKind).toBe(atCap);
  });

  it("drops the WHOLE worktree entry when one of its strings is over cap", async () => {
    // Valid-or-absent: four good fields beside one the boundary would refuse is
    // not a usable record.
    const session = await parse([
      worktreeLine({ ...CREATED, worktreeBranch: overCap }),
      userLine(),
    ]);

    expect(session).not.toHaveProperty("worktreeEntries");
  });

  it("drops an over-cap effort tier without losing the session", async () => {
    const session = await parse([
      userLine(),
      JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        timestamp: "2026-07-09T12:00:01.000Z",
        effort: overCap,
        message: {
          id: "m-1",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ]);

    expect(session).toBeTruthy();
    expect(session?.usageExtras.efforts ?? []).toEqual([]);
  });
});
