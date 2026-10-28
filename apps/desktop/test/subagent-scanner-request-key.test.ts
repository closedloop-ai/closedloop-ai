/**
 * ISS-12552 (PRD-800 "Proving usage"): a Claude subagent's sidecar
 * tool call names the request that issued it, as the main transcript lane
 * does, so a receipt on a subagent's write joins that request's usage.
 */
import "./support/attribution-parse-policy.js";
import assert from "node:assert/strict";
import { TokenSourceIdentityAvailability } from "@repo/api/src/types/token-cost-provenance";
import { requestKeyFor } from "@repo/lib/harness/request-key";
import { claudeTranscriptEntryUuidScheme } from "@repo/lib/harness/usage-dedup";
import { test } from "vitest";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { PARSE_POLICY_BASE } from "../src/main/parse-policy/parse-policy.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";
import {
  assistantLine,
  DELEGATING_ONLY_PARENT,
} from "./sidecar-diff-stats-fixtures.js";

const SUBAGENT_LINE = "44444444-4444-4444-8444-444444444444";

test("a sidecar tool call names a request its own usage identity lists", async () => {
  const filePath = writeClaudeTranscript(
    "sess-sidecar-request-key",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(SUBAGENT_LINE, "req_sub", "msg_sub", [
            {
              type: "tool_use",
              id: "toolu_write",
              name: "mcp__closedloop__create-document",
              input: { title: "Plan" },
            },
          ]),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);

  const subagent = (parsed?.subagents ?? []).find((s) => s.id === "agent-lane");
  const write = subagent?.toolUses?.find((use) => use.id === "toolu_write");
  const expected = requestKeyFor(
    claudeTranscriptEntryUuidScheme,
    SUBAGENT_LINE
  );
  assert.equal(write?.requestKey, expected);
  const requestKeys = (parsed?.tokenSeries ?? []).flatMap((entry) => {
    const identity = entry.sourceIdentity;
    return identity?.availability === TokenSourceIdentityAvailability.Available
      ? identity.sourceRecordIds.map((id) => requestKeyFor(identity.scheme, id))
      : [];
  });
  assert.ok(
    requestKeys.includes(expected),
    "the subagent request's usage must list the tool call's line"
  );
});

test("a sidecar tool call names no request with the attribution policy off", async () => {
  const filePath = writeClaudeTranscript(
    "sess-sidecar-request-key-off",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(SUBAGENT_LINE, "req_sub", "msg_sub", [
            {
              type: "tool_use",
              id: "toolu_write",
              name: "mcp__closedloop__create-document",
              input: { title: "Plan" },
            },
          ]),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(
    filePath,
    undefined,
    undefined,
    PARSE_POLICY_BASE
  );

  const subagent = (parsed?.subagents ?? []).find((s) => s.id === "agent-lane");
  const write = subagent?.toolUses?.find((use) => use.id === "toolu_write");
  assert.ok(write, "the sidecar call must still be parsed");
  assert.equal(write.requestKey, undefined);
});
