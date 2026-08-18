import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionTraceSyncFields } from "../src/main/database/session-trace.js";
import {
  baseSessionTraceInput as baseInput,
  traceTokenEvent,
} from "./session-trace-test-utils.js";

// FEA-3781: the desktop half of the autonomy fix. `buildSessionTraceSyncFields`
// is the only production caller of the deriver, and it is where the defect
// actually lived: it built ONE combined activity stream that still contained the
// human's own prompts, so a trailing prompt became the session's last activity
// and every agent-working span collapsed. The deriver could not tell "the agent
// worked last" from "the human spoke last" because the desktop never told it.
//
// These tests pin the SPLIT at this boundary — that human prompts reach
// `promptTimestamps` and only agent rows plus token events reach the agent
// stream — by asserting the score the deriver returns for shapes that can only
// come out right if the split is right. A fixture that fed the deriver a
// combined stream would be testing an input production never produces.

const promptRow = (createdAt: string) => ({
  eventType: "UserMessage",
  toolName: null,
  createdAt,
  label: "Prompt",
});

const agentRow = (createdAt: string) => ({
  eventType: "AssistantMessage",
  toolName: null,
  createdAt,
  label: "opus",
});

/** The hook-captured twin of a human prompt (FEA-3671). */
const hookPromptRow = (createdAt: string) => ({
  eventType: "UserPromptSubmit",
  toolName: null,
  createdAt,
  label: "Prompt",
});

test("human prompts are excluded from the agent activity stream", () => {
  // Prompt, 5 min of agent work, prompt again. If prompts leaked into the agent
  // stream the trailing prompt would be the last "agent" activity and the score
  // would collapse; with the streams split it is a clean 50/50 split of 5 min
  // worked against 5 min attended.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:10:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      metadata: {
        messages: [
          { role: "human", timestamp: "2026-06-07T12:00:00.000Z" },
          { role: "assistant", timestamp: "2026-06-07T12:05:00.000Z" },
          { role: "human", timestamp: "2026-06-07T12:10:00.000Z" },
        ],
      },
      timelineRows: [
        promptRow("2026-06-07T12:00:00.000Z"),
        agentRow("2026-06-07T12:05:00.000Z"),
        promptRow("2026-06-07T12:10:00.000Z"),
      ],
    })
  );

  assert.equal(fields.autonomy, 50);
  assert.equal(fields.steeringEpisodes, 1);
});

test("FEA-3671: a UserPromptSubmit hook twin is not counted as agent work", () => {
  // buildTraceTimelineRows deliberately carries the hook event BESIDE the
  // transcript UserMessage. Both describe the same human turn, so sending the
  // twin down the agent stream made the trailing prompt look like agent work —
  // this exact 50/50 session scored 100. With a transcript present, UserMessage
  // is the authoritative prompt and the twin belongs to neither stream.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:10:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      metadata: {
        messages: [
          { role: "human", timestamp: "2026-06-07T12:00:00.000Z" },
          { role: "assistant", timestamp: "2026-06-07T12:05:00.000Z" },
          { role: "human", timestamp: "2026-06-07T12:10:00.000Z" },
        ],
      },
      timelineRows: [
        promptRow("2026-06-07T12:00:00.000Z"),
        hookPromptRow("2026-06-07T12:00:00.000Z"),
        agentRow("2026-06-07T12:05:00.000Z"),
        promptRow("2026-06-07T12:10:00.000Z"),
        hookPromptRow("2026-06-07T12:10:00.000Z"),
      ],
    })
  );

  assert.equal(fields.autonomy, 50);
  assert.equal(fields.steeringEpisodes, 1);
});

test("FEA-3671: a hook-only session (no transcript) is scored, not left Unknown", () => {
  // A transcript-less live session has no UserMessage rows at all — only the
  // UserPromptSubmit hook events. Keying prompts strictly on UserMessage left
  // these with zero prompts, so they scored Unknown forever. The transcript-less
  // regime falls back to the broad user/prompt event-name match, exactly as the
  // human-turn rollup does.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:10:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      // No `messages` key → no parsed transcript.
      metadata: {},
      timelineRows: [
        hookPromptRow("2026-06-07T12:00:00.000Z"),
        agentRow("2026-06-07T12:05:00.000Z"),
        hookPromptRow("2026-06-07T12:10:00.000Z"),
      ],
    })
  );

  assert.notEqual(fields.autonomy, null);
  assert.equal(fields.autonomy, 50);
  assert.equal(fields.steeringEpisodes, 1);
});

test("token events count as agent activity", () => {
  // A session whose only agent evidence is token usage must still score: token
  // events are part of the agent stream, not a separate concern.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:10:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      metadata: {
        messages: [
          { role: "human", timestamp: "2026-06-07T12:00:00.000Z" },
          { role: "human", timestamp: "2026-06-07T12:10:00.000Z" },
        ],
      },
      timelineRows: [
        promptRow("2026-06-07T12:00:00.000Z"),
        promptRow("2026-06-07T12:10:00.000Z"),
      ],
      tokenEvents: [traceTokenEvent("2026-06-07T12:05:00.000Z")],
    })
  );

  assert.equal(fields.autonomy, 50);
});

test("a session ending on a human turn is scored, not blanked", () => {
  // The originally-reported defect: real interaction, blank score. The desktop
  // used to hand the deriver a stream whose last entry was this trailing prompt.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:20:00.000Z",
      endedAt: null,
      metadata: {
        messages: [
          { role: "human", timestamp: "2026-06-07T12:00:00.000Z" },
          { role: "assistant", timestamp: "2026-06-07T12:02:00.000Z" },
          { role: "human", timestamp: "2026-06-07T12:04:00.000Z" },
        ],
      },
      timelineRows: [
        promptRow("2026-06-07T12:00:00.000Z"),
        agentRow("2026-06-07T12:02:00.000Z"),
        promptRow("2026-06-07T12:04:00.000Z"),
      ],
    })
  );

  assert.notEqual(fields.autonomy, null);
  assert.equal(fields.autonomy, 50);
});

test("a human prompt with no agent response scores 0, not null", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:10:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      metadata: {
        messages: [
          { role: "human", timestamp: "2026-06-07T12:00:00.000Z" },
          { role: "human", timestamp: "2026-06-07T12:10:00.000Z" },
        ],
      },
      timelineRows: [
        promptRow("2026-06-07T12:00:00.000Z"),
        promptRow("2026-06-07T12:10:00.000Z"),
      ],
    })
  );

  assert.equal(fields.autonomy, 0);
  assert.equal(fields.steeringEpisodes, 1);
});

test("an sdk-launched entrypoint is treated as headless and scores fully agentic", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:10:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      metadata: {
        entrypoint: "sdk-ts",
        messages: [
          { role: "human", timestamp: "2026-06-07T12:00:00.000Z" },
          { role: "assistant", timestamp: "2026-06-07T12:05:00.000Z" },
          { role: "human", timestamp: "2026-06-07T12:10:00.000Z" },
        ],
      },
      timelineRows: [
        promptRow("2026-06-07T12:00:00.000Z"),
        agentRow("2026-06-07T12:05:00.000Z"),
        promptRow("2026-06-07T12:10:00.000Z"),
      ],
    })
  );

  assert.equal(fields.autonomy, 100);
  assert.equal(fields.steeringEpisodes, 0);
});

test("FEA-3594: /exit row excluded from promptTimestamps — does not inflate steeringEpisodes", () => {
  // A session with one real kickoff prompt, two agent responses, then an /exit
  // command. buildTraceTimelineRows labels the exit row "/exit" (matching
  // slashCommands), so buildSessionAutonomyInput's isSessionTerminatingLabel
  // guard fires and excludes it from promptTimestamps.
  //
  // Without the fix /exit would be a second prompt → steeringEpisodes=1.
  // With the fix the session has only the kickoff prompt → steeringEpisodes=0.
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
          {
            timestamp: "2026-07-19T06:00:00.000Z",
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
          eventType: "AssistantMessage",
          toolName: null,
          createdAt: "2026-07-19T06:00:00.000Z",
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

  assert.equal(
    fields.steeringEpisodes,
    0,
    "/exit must not inflate steering episodes"
  );
});

test("FEA-3781: bypassPermissions alone no longer asserts a session is autonomous", () => {
  // Identical input to the case above minus the sdk entrypoint. Interactive
  // operators routinely run with permissions skipped, so `permissionMode` on its
  // own must not override the measurement — it used to short-circuit this to
  // 100/0. `isHeadlessSession` itself is unchanged and still consults it for the
  // human-turn classification; only autonomy stops trusting it.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:10:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      metadata: {
        entrypoint: "cli",
        permissionMode: "bypassPermissions",
        messages: [
          { role: "human", timestamp: "2026-06-07T12:00:00.000Z" },
          { role: "assistant", timestamp: "2026-06-07T12:05:00.000Z" },
          { role: "human", timestamp: "2026-06-07T12:10:00.000Z" },
        ],
      },
      timelineRows: [
        promptRow("2026-06-07T12:00:00.000Z"),
        agentRow("2026-06-07T12:05:00.000Z"),
        promptRow("2026-06-07T12:10:00.000Z"),
      ],
    })
  );

  assert.equal(fields.autonomy, 50);
  assert.equal(fields.steeringEpisodes, 1);
});
