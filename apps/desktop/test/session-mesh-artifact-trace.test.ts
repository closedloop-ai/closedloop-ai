import { describe, expect, it } from "vitest";
import {
  extractSessionMeshArtifactUuids,
  extractSessionMeshPullRequest,
  SessionMeshArtifactInteraction,
  sessionMeshTraceSubjects,
} from "../src/main/session-mesh/session-mesh-artifact-trace.js";
import type { SessionMeshHookEvent } from "../src/main/session-mesh/session-mesh-hook-contract.js";
import { SESSION_MESH_SEND_MESSAGE_TOOL } from "../src/main/session-mesh/session-mesh-send-message-relevance.js";

const ARTIFACT_UUID = "019ef509-5774-7618-922c-753000d5f079";
const REPOSITORY = "github.com/closedloop-ai/closedloop-ai";

function subjectsOf(event: SessionMeshHookEvent) {
  return sessionMeshTraceSubjects(event, REPOSITORY);
}

function pullRequestIn(text: string) {
  return extractSessionMeshPullRequest(text, REPOSITORY);
}

function promptEvent(prompt: string): SessionMeshHookEvent {
  return {
    harness: "claude",
    hookType: "UserPromptSubmit",
    data: { session_id: "s1", cwd: "/repo", prompt },
  };
}

describe("sessionMeshTraceSubjects", () => {
  it("classifies a review of a pull request and carries its routing keys", () => {
    const trace = subjectsOf(
      promptEvent("please review PR-8536 before I enqueue it")
    );
    expect(trace.interaction).toBe(SessionMeshArtifactInteraction.Reviewing);
    expect(trace.symbols).toContain("PR-8536");
    expect(trace.pullRequest).toBe("#8536");
  });

  it("classifies implementing, planning and found dependencies distinctly", () => {
    expect(subjectsOf(promptEvent("implement ISS-12167 now")).interaction).toBe(
      SessionMeshArtifactInteraction.Implementing
    );
    expect(subjectsOf(promptEvent("let's plan PRD-567")).interaction).toBe(
      SessionMeshArtifactInteraction.Planning
    );
    expect(
      subjectsOf(promptEvent("ISS-12167 is blocked by ISS-10797")).interaction
    ).toBe(SessionMeshArtifactInteraction.DependencyFound);
  });

  it("ranks a found dependency above the implementing verb in one prompt", () => {
    // Precedence the table encodes: the dependency is the fact a peer cannot
    // derive for themselves, so it wins over the generic verb beside it.
    expect(
      subjectsOf(promptEvent("implement ISS-1 — it depends on ISS-2"))
        .interaction
    ).toBe(SessionMeshArtifactInteraction.DependencyFound);
  });

  it("publishes no interaction when the trace names no artifact", () => {
    const trace = subjectsOf(
      promptEvent("please review this and implement the fix")
    );
    expect(trace.interaction).toBeNull();
    expect(trace.symbols).toEqual([]);
  });

  it("leaves the SendMessage event to its own mirror", () => {
    const trace = subjectsOf({
      harness: "claude",
      hookType: "PreToolUse",
      data: {
        session_id: "s1",
        cwd: "/repo",
        tool_name: SESSION_MESH_SEND_MESSAGE_TOOL,
        tool_input: { summary: "reviewing ISS-12167" },
      },
    });
    expect(trace.interaction).toBeNull();
  });

  it("mines a gh pr command typed into a prompt", () => {
    // The prompt is the only path a `gh pr` command reaches this runtime by:
    // the installed PreToolUse matcher never fires on Bash.
    const trace = subjectsOf(
      promptEvent("run gh pr view 8536 --comments and review it")
    );
    expect(trace.pullRequest).toBe("#8536");
    expect(trace.symbols).toContain("PR-8536");
  });

  it("drops an artifact id the lineage validator would reject", () => {
    // Any 8-4-4-4-12 hex matches the pattern; this one fails the version and
    // variant nibbles, and parsing it into presence would throw on the hook path.
    const trace = subjectsOf(
      promptEvent(
        "review documents/12345678-1234-1234-1234-123456789abc and ISS-1"
      )
    );
    expect(trace.artifactIds).toEqual([]);
    expect(trace.interaction).toBe(SessionMeshArtifactInteraction.Reviewing);
  });

  it("takes an artifact uuid only from an artifact-shaped reference", () => {
    const trace = subjectsOf(
      promptEvent(`open /documents/${ARTIFACT_UUID} and review it`)
    );
    expect(trace.artifactIds).toEqual([ARTIFACT_UUID]);
    expect(
      subjectsOf(promptEvent(`session ${ARTIFACT_UUID} review`)).artifactIds
    ).toEqual([]);
  });

  it("returns an empty trace for an event carrying no text", () => {
    const trace = subjectsOf({
      harness: "claude",
      hookType: "SessionStart",
      data: { session_id: "s1", cwd: "/repo" },
    });
    expect(trace).toEqual({
      symbols: [],
      artifactIds: [],
      interaction: null,
    });
  });

  it("redacts a credential before it can become a subject", () => {
    const trace = subjectsOf(
      promptEvent("review https://u:sk_live_abcdefghijklmnop@example.com/x")
    );
    expect(JSON.stringify(trace)).not.toContain("sk_live_abcdefghijklmnop");
  });
});

describe("extractSessionMeshPullRequest", () => {
  it("normalizes every spelling to one canonical value", () => {
    for (const text of [
      "https://github.com/closedloop-ai/closedloop-ai/pull/8536",
      "gh pr view 8536",
      "PR-8536",
      "see #8536 for context",
    ]) {
      expect(pullRequestIn(text)).toBe("#8536");
    }
  });

  it("strips leading zeroes so two spellings cannot be two pull requests", () => {
    expect(pullRequestIn("see #0042")).toBe("#42");
  });

  it("ignores a single-digit hash, which is rarely a pull request", () => {
    expect(pullRequestIn("heading #1 of the doc")).toBeUndefined();
  });

  it("takes the number of a gh pr command only directly after its verb", () => {
    expect(pullRequestIn("gh pr list --limit 50")).toBeUndefined();
    expect(pullRequestIn("gh pr list --search ISS-12167")).toBeUndefined();
    expect(pullRequestIn("gh pr checkout 8536")).toBe("#8536");
  });

  it("ignores a pull request URL from another repository", () => {
    expect(
      pullRequestIn(
        "review https://github.com/another-org/another-repo/pull/8536"
      )
    ).toBeUndefined();
    expect(
      pullRequestIn(
        "review https://github.com/Closedloop-AI/ClosedLoop-AI/pull/8536"
      )
    ).toBe("#8536");
  });

  it("finds no pull request in text that names none", () => {
    expect(pullRequestIn("ISS-12167 only")).toBeUndefined();
  });
});

describe("extractSessionMeshArtifactUuids", () => {
  it("deduplicates and lowercases", () => {
    expect(
      extractSessionMeshArtifactUuids(
        `documents/${ARTIFACT_UUID.toUpperCase()} and documents/${ARTIFACT_UUID}`
      )
    ).toEqual([ARTIFACT_UUID]);
  });
});
