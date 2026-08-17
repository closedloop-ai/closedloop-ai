import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionTraceSyncFields } from "../src/main/database/session-trace.js";
import { baseSessionTraceInput as baseInput } from "./session-trace-test-utils.js";

// FEA-3671: a session whose ONLY user input is a local meta command (`/login`,
// `isMeta:true`) correctly parses to humanTurns=0 — the parser excludes such
// entries from `metadata.messages` (isSyntheticUserEntry). But the timeline still
// carried the hook-captured `UserPromptSubmit` events, and `traceMarkerKind`
// emitted a `kind:"prompt"` marker for any row whose event_type matched
// user/prompt — so the timeline rendered prompt markers while humanTurns=0, the
// contradiction Andrew (QA) flagged. The marker derivation must honor the same
// transcript-first precedence the human-turn rollup uses
// (COALESCE(transcript_human_turns, ht.human_turns)): with a transcript present,
// only `role:"human"` (UserMessage) rows are human prompts; hook UserPromptSubmit
// events are NOT.

const promptMarkers = (
  fields: ReturnType<typeof buildSessionTraceSyncFields>
) => (fields.markers ?? []).filter((marker) => marker.kind === "prompt");

test("meta-only /login session (transcript, 0 human turns) emits NO prompt markers", () => {
  // The parser produced a transcript (metadata.messages is an array) but excluded
  // the `/login` meta entries, so there are zero role:"human" messages →
  // humanTurns=0. The `events` table still holds the two UserPromptSubmit hook
  // rows, which buildTraceTimelineRows surfaces as user/prompt event rows.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:01:00.000Z",
      updatedAt: "2026-06-07T12:01:00.000Z",
      // Transcript present, but NO role:"human" messages (all input was /login).
      metadata: { messages: [] },
      timelineRows: [
        {
          eventType: "UserPromptSubmit",
          toolName: null,
          createdAt: "2026-06-07T12:00:00.000Z",
          label: "/login",
        },
        {
          eventType: "UserPromptSubmit",
          toolName: null,
          createdAt: "2026-06-07T12:00:30.000Z",
          label: "/login",
        },
      ],
    })
  );

  assert.equal(
    promptMarkers(fields).length,
    0,
    "a meta-only session with humanTurns=0 must render zero human prompt markers"
  );
});

test("normal session with a real human turn still renders its prompt marker", () => {
  // A genuine human prompt is a role:"human" message → UserMessage timeline row.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:05:00.000Z",
      updatedAt: "2026-06-07T12:05:00.000Z",
      metadata: {
        messages: [{ role: "human", timestamp: "2026-06-07T12:00:00.000Z" }],
      },
      timelineRows: [
        {
          eventType: "UserMessage",
          toolName: null,
          createdAt: "2026-06-07T12:00:00.000Z",
          label: "Prompt",
        },
        {
          eventType: "AssistantMessage",
          toolName: null,
          createdAt: "2026-06-07T12:02:00.000Z",
          label: "opus",
        },
      ],
    })
  );

  assert.equal(
    promptMarkers(fields).length,
    1,
    "a real human turn must still surface its prompt marker"
  );
});

test("transcript-present session drops duplicate UserPromptSubmit hook markers", () => {
  // One real human prompt (UserMessage) plus the hook's UserPromptSubmit twin for
  // the same turn. Pre-fix both matched user/prompt and emitted two prompt markers
  // (double-count); the transcript-first rule keeps only the UserMessage one.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:05:00.000Z",
      updatedAt: "2026-06-07T12:05:00.000Z",
      metadata: {
        messages: [{ role: "human", timestamp: "2026-06-07T12:00:00.000Z" }],
      },
      timelineRows: [
        {
          eventType: "UserMessage",
          toolName: null,
          createdAt: "2026-06-07T12:00:00.000Z",
          label: "Prompt",
        },
        {
          eventType: "UserPromptSubmit",
          toolName: null,
          createdAt: "2026-06-07T12:00:00.000Z",
          label: "prompt",
        },
      ],
    })
  );

  assert.equal(
    promptMarkers(fields).length,
    1,
    "the hook UserPromptSubmit twin must not add a second prompt marker"
  );
});

test("transcript-less (hook-only live) session still surfaces UserPromptSubmit markers", () => {
  // No parsed transcript (metadata.messages absent) — the human-turn count itself
  // falls back to counting user/prompt events, so the prompt markers must too.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:05:00.000Z",
      updatedAt: "2026-06-07T12:05:00.000Z",
      metadata: null,
      timelineRows: [
        {
          eventType: "UserPromptSubmit",
          toolName: null,
          createdAt: "2026-06-07T12:00:00.000Z",
          label: "prompt",
        },
      ],
    })
  );

  assert.equal(
    promptMarkers(fields).length,
    1,
    "a hook-only session with no transcript keeps its UserPromptSubmit prompt marker"
  );
});

test("FEA-3594: /exit human turn is NOT rendered as a prompt marker", () => {
  // A session where the parser captured a real kickoff prompt followed by an
  // /exit command. buildTraceTimelineRows labels the exit row "/exit" (matching
  // slashCommands), so traceMarkerKind's isSessionTerminatingLabel guard fires
  // and suppresses the prompt marker. The transcript is present
  // (metadata.messages is an array), so hasTranscript=true and UserMessage rows
  // are the authoritative human turns — exactly the regime where
  // isSessionTerminatingLabel is consulted.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-07-18T19:09:00.000Z",
      endedAt: "2026-07-20T23:11:00.000Z",
      updatedAt: "2026-07-20T23:11:00.000Z",
      metadata: {
        messages: [
          { timestamp: "2026-07-18T19:09:18.000Z", role: "human" },
          {
            timestamp: "2026-07-18T19:09:25.000Z",
            role: "assistant",
            model: "opus",
          },
          { timestamp: "2026-07-20T15:05:00.000Z", role: "human" },
        ],
        slashCommands: [
          { name: "/exit", timestamp: "2026-07-20T15:05:00.000Z" },
        ],
      },
      // Rows as buildTraceTimelineRows would produce them: the second human
      // message receives label "/exit" because its timestamp matches a
      // terminating slashCommands entry.
      timelineRows: [
        {
          eventType: "UserMessage",
          toolName: null,
          createdAt: "2026-07-18T19:09:18.000Z",
          label: "Prompt",
        },
        {
          eventType: "AssistantMessage",
          toolName: null,
          createdAt: "2026-07-18T19:09:25.000Z",
          label: "opus",
        },
        {
          eventType: "UserMessage",
          toolName: null,
          createdAt: "2026-07-20T15:05:00.000Z",
          label: "/exit",
        },
      ],
    })
  );

  const prompts = (fields.markers ?? []).filter((m) => m.kind === "prompt");
  assert.equal(
    prompts.length,
    1,
    "only the real kickoff prompt should be a marker, not /exit"
  );
});
