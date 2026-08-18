/**
 * @file review-intent-detector.test.ts
 * @description FEA-2269 state-aware attribution (PRD-488): deterministic tests
 * for the review-REQUEST detector — the declared signal that establishes the
 * `review` phase. Asserts (1) the NL perform-review cue's precision vs the
 * address-review shape it must NOT swallow, (2) the command/skill name cue, and
 * (3) `computeReviewRequestMs` collecting + de-duplicating request timestamps.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeReviewRequestMs,
  isReviewRequestCommandName,
  isReviewRequestPrompt,
} from "../src/main/collectors/parsing/review-intent-detector.js";
import type { NormalizedMessage } from "../src/main/collectors/types.js";
import { makeSession } from "./normalized-session-test-utils.js";

const ms = (iso: string): number => Date.parse(iso);
function humanMsg(text: string, timestamp: string): NormalizedMessage {
  return { role: "human", timestamp, text };
}

// ── The NL perform-review cue ────────────────────────────────────────────────
test("isReviewRequestPrompt matches requests to PERFORM a review of the user's work", () => {
  for (const text of [
    "code review my local changes",
    "review the diff",
    "please review my code",
    "do a code review of my changes",
    "review this PR",
    "can you review my branch",
    "REVIEW MY CHANGES", // case-insensitive
    "please   review   my    diff", // collapsed whitespace
  ]) {
    assert.equal(isReviewRequestPrompt(text), true, text);
  }
});

test("isReviewRequestPrompt vetoes a DECLINED review intent (negation guard)", () => {
  for (const text of [
    "don't review my changes yet",
    "we don't need to review my changes",
    "no need to review my code right now",
    "hold off on reviewing my changes",
  ]) {
    assert.equal(isReviewRequestPrompt(text), false, text);
  }
  // …but a do-anyway idiom is NOT a decline and still matches.
  assert.equal(
    isReviewRequestPrompt("don't forget to review my changes"),
    true
  );
});

test("isReviewRequestPrompt yields to address-review when a compound prompt matches both cues", () => {
  // A prompt that is BOTH a perform-review request and an address-review (rework)
  // instruction resolves to rework, not review — rework carries the ≥1-edit gate.
  for (const text of [
    "review my changes and address the review comments",
    "review this PR and fix the PR feedback",
  ]) {
    assert.equal(isReviewRequestPrompt(text), false, text);
  }
});

test("isReviewRequestPrompt does NOT match address-review or unrelated prompts", () => {
  for (const text of [
    // address-review is rework's cue (object is comments/feedback, not work)
    "address the review comments",
    "fix the PR feedback",
    "evaluate the following code review comments",
    // `preview` must not trip the `review` boundary
    "preview the landing page",
    // no review directive at all
    "implement the auth flow",
    "let's plan the feature",
  ]) {
    assert.equal(isReviewRequestPrompt(text), false, text);
  }
});

// ── The command / skill name rule ────────────────────────────────────────────
test("isReviewRequestCommandName reads names as WORDS, not substrings", () => {
  for (const name of [
    "code-review",
    "security-review",
    "review-pr",
    "review",
    "code-review:start",
  ]) {
    assert.equal(isReviewRequestCommandName(name), true, name);
  }
  for (const name of ["preview", "plan", "implement", "commit"]) {
    assert.equal(isReviewRequestCommandName(name), false, name);
  }
});

test("a command that ACTS ON reviews is not a request to perform one", () => {
  // AA-06(a): `apply-nightly-reviews` triages bot-review PRs — rework, not a
  // review. Under the old `/\breview/i` substring scan it painted a 16.5-minute
  // implement+validate arc as `review` @0.9 with a fabricated declared layer.
  for (const name of [
    "apply-nightly-reviews",
    "address-review-comments",
    "fix-review-findings",
    "resolve-reviews",
  ]) {
    assert.equal(isReviewRequestCommandName(name), false, name);
  }
});

// ── computeReviewRequestMs ───────────────────────────────────────────────────
test("computeReviewRequestMs collects request timestamps from commands, skills, and prompts", () => {
  const session = makeSession({
    slashCommands: [
      { name: "code-review", timestamp: "2026-01-01T00:10:00.000Z" },
      { name: "plan", timestamp: "2026-01-01T00:05:00.000Z" },
    ],
    skills: [
      { name: "security-review", timestamp: "2026-01-01T00:20:00.000Z" },
    ],
    messages: [
      humanMsg("review my local changes", "2026-01-01T00:30:00.000Z"),
      humanMsg("address the review comments", "2026-01-01T00:40:00.000Z"),
    ],
  });

  assert.deepEqual(computeReviewRequestMs(session), [
    ms("2026-01-01T00:10:00.000Z"), // code-review command
    ms("2026-01-01T00:20:00.000Z"), // security-review skill
    ms("2026-01-01T00:30:00.000Z"), // "review my local changes" prompt
    // the "plan" command and the address-review prompt are excluded
  ]);
});

test("computeReviewRequestMs excludes declined and compound address-review prompts", () => {
  const session = makeSession({
    messages: [
      humanMsg("don't review my changes yet", "2026-01-01T00:10:00.000Z"),
      humanMsg(
        "review my changes and address the PR comments",
        "2026-01-01T00:20:00.000Z"
      ),
      humanMsg("review my code", "2026-01-01T00:30:00.000Z"), // the only real request
    ],
  });
  assert.deepEqual(computeReviewRequestMs(session), [
    ms("2026-01-01T00:30:00.000Z"),
  ]);
});

test("computeReviewRequestMs is empty when the session has no review request", () => {
  const session = makeSession({
    slashCommands: [{ name: "plan", timestamp: "2026-01-01T00:05:00.000Z" }],
    messages: [humanMsg("implement the parser", "2026-01-01T00:06:00.000Z")],
  });
  assert.deepEqual(computeReviewRequestMs(session), []);
});

// ── AA-06: request detection (PLN-1490 step 4) ──────────────────────────────

test("AA-06: a re-run request re-establishes the review phase", () => {
  // "re-run the review" puts the review noun as the OBJECT of a run verb with
  // nothing after it, so the work-object cue cannot reach it. In `b50de790` this
  // opened the session's only SUCCESSFUL review execution and it carried no
  // declared review provenance at all.
  for (const text of [
    "re-run the review; I now have more tokens",
    "rerun the review please",
    "do another code review",
    "repeat that review",
    "run the review again",
  ]) {
    assert.equal(isReviewRequestPrompt(text), true, text);
  }
});

test("AA-06: an address-review prompt still outranks a re-run shape", () => {
  // Precedence is explicit: rework carries the stricter edit gate, so a compound
  // prompt must not be reclassified as a request to PERFORM a review.
  assert.equal(
    isReviewRequestPrompt("re-run through the review comments and fix them"),
    false
  );
  assert.equal(isReviewRequestPrompt("don't re-run the review yet"), false);
  // The veto's word gap has to clear the LONGEST verb the request cue admits.
  // "kick off" spends the whole budget on the verb itself, so a two-word gap
  // never reached the noun and the decline read as a request to perform one.
  assert.equal(isReviewRequestPrompt("don't kick off the review"), false);
  assert.equal(isReviewRequestPrompt("no need to kick off the review"), false);
  // ...while the positive form of the same verb is unaffected.
  assert.equal(isReviewRequestPrompt("kick off the review"), true);
});

test("AA-06: subagent-scoped skills are not main-session review requests", () => {
  // A spawned reviewer invoking the review skill internally declares what the
  // SUBAGENT was asked to do. Counting it as a parent transition would flip the
  // phase of a session whose parent never requested a review.
  const session = makeSession({
    skills: [
      {
        name: "code-review",
        timestamp: "2026-01-01T00:10:00.000Z",
        subagentId: null,
      },
      {
        name: "code-review",
        timestamp: "2026-01-01T00:11:00.000Z",
        subagentId: "agent-a38cd6f58b3ee04f4",
      },
    ],
  });
  assert.deepEqual(computeReviewRequestMs(session), [
    Date.parse("2026-01-01T00:10:00.000Z"),
  ]);
});

test("AA-06: a skill that ACTS ON reviews mints no request instant", () => {
  const session = makeSession({
    skills: [
      {
        name: "apply-nightly-reviews",
        timestamp: "2026-01-01T00:10:00.000Z",
        subagentId: null,
      },
    ],
  });
  assert.deepEqual(computeReviewRequestMs(session), []);
});
