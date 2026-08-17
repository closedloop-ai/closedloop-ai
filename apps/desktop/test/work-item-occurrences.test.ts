/**
 * @file work-item-occurrences.test.ts
 * @description FEA-4010 (AA-10) unit tests for the per-occurrence work-item
 * mention stream: which surfaces are scanned, that transcript time is carried
 * through, and that the exclusions matching the extractor's bare-slug pass hold.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractWorkItemOccurrences } from "../src/main/collectors/parsing/work-item-occurrences.js";
import {
  createNormalizedSession,
  type NormalizedSession,
} from "../src/main/collectors/types.js";

const T0 = "2026-07-01T10:00:00.000Z";
const T1 = "2026-07-01T10:05:00.000Z";
const ms = (iso: string) => Date.parse(iso);

function sessionWith(overrides: Partial<NormalizedSession>): NormalizedSession {
  return createNormalizedSession({ sessionId: "s", ...overrides });
}

test("a slug in a message is an occurrence at that message's time", () => {
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      messages: [{ role: "human", timestamp: T0, text: "start on FEA-1224" }],
    })
  );
  assert.deepEqual(occurrences, [{ slug: "FEA-1224", occurredAtMs: ms(T0) }]);
});

test("a slug in a tool INPUT is an occurrence at that tool's time", () => {
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      toolUses: [
        {
          name: "Bash",
          timestamp: T1,
          input: { command: 'git commit -m "FEA-1224: fix"' },
        },
      ],
    })
  );
  assert.deepEqual(occurrences, [{ slug: "FEA-1224", occurredAtMs: ms(T1) }]);
});

test("a slug in tool OUTPUT is NOT an occurrence", () => {
  // A slug in a file the agent READ is incidental context, not work on that item
  // — the audit traced a wrong label to 27 docstring mentions in read output.
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      toolUses: [
        {
          name: "Read",
          timestamp: T1,
          input: { file_path: "/repo/src/app.ts" },
          output: "// see FEA-1189 for context",
        },
      ],
    })
  );
  assert.deepEqual(occurrences, []);
});

test("a slug inside a code fence is not an occurrence", () => {
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      messages: [
        {
          role: "assistant",
          timestamp: T0,
          text: "example:\n```\nFEA-1189 in a fence\n```\n",
        },
      ],
    })
  );
  assert.deepEqual(occurrences, []);
});

test("a record with no usable timestamp is dropped, not guessed at", () => {
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      messages: [
        { role: "human", timestamp: "not-a-date", text: "FEA-1224" },
        { role: "human", timestamp: T0, text: "FEA-1224" },
      ],
    })
  );
  assert.deepEqual(occurrences, [{ slug: "FEA-1224", occurredAtMs: ms(T0) }]);
});

test("every mention is kept, so downstream can count dominance", () => {
  // Deduping here would discard exactly the signal that lets the resolver tell a
  // discussed work item from a single incidental reference.
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      messages: [
        { role: "human", timestamp: T0, text: "FEA-1224 and FEA-1224 again" },
      ],
    })
  );
  assert.equal(occurrences.length, 2);
});

test("occurrences are time-ordered regardless of input order", () => {
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      messages: [{ role: "human", timestamp: T1, text: "PLN-900" }],
      toolUses: [
        { name: "Bash", timestamp: T0, input: { command: "echo FEA-1224" } },
      ],
    })
  );
  assert.deepEqual(occurrences, [
    { slug: "FEA-1224", occurredAtMs: ms(T0) },
    { slug: "PLN-900", occurredAtMs: ms(T1) },
  ]);
});

test("a slug spelled lower-case in a branch name is an occurrence", () => {
  // The dominant spelling of the real work item is the branch, and branches are
  // lower-case by convention. A case-SENSITIVE scan made the strongest signal in
  // the session invisible: golden `019effc3` is entirely FEA-2159 on branch
  // `kaiticarp/fea-2159-…`, and resolved to a chattier unrelated slug without it.
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      toolUses: [
        {
          name: "Bash",
          timestamp: T0,
          input: { command: "git checkout -b ci/pause-arm-shadow-fea-2172" },
        },
      ],
    })
  );
  assert.deepEqual(occurrences, [{ slug: "FEA-2172", occurredAtMs: ms(T0) }]);
});

test("mixed-case spellings of one slug collapse to a single upper-case identity", () => {
  // Non-Closedloop-shaped: a Jira-style lower-case ref in a worktree path plus the
  // upper-case prose form must count as the SAME item, or dominance splits its own
  // vote and a passing mention wins the segment.
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      messages: [{ role: "human", timestamp: T0, text: "land PLN-42 today" }],
      toolUses: [
        {
          name: "Bash",
          timestamp: T0,
          input: { command: "git worktree add ../wt-pln-42 feat/Pln-42" },
        },
      ],
    })
  );
  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.slug),
    ["PLN-42", "PLN-42", "PLN-42"]
  );
});

test("a non-work-item slug family is still emitted; the resolver gates families", () => {
  // Keeping the stream family-agnostic means the work-item gate lives in exactly
  // one place (the resolver's WORK_ITEM_SLUG_RE) rather than drifting in two.
  const occurrences = extractWorkItemOccurrences(
    sessionWith({
      messages: [{ role: "human", timestamp: T0, text: "see PRO-7" }],
    })
  );
  assert.deepEqual(occurrences, [{ slug: "PRO-7", occurredAtMs: ms(T0) }]);
});
