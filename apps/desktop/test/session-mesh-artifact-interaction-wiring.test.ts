import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMeshArtifactInteraction } from "../src/main/session-mesh/session-mesh-artifact-trace.js";
import { SessionMeshEvidenceObserver } from "../src/main/session-mesh/session-mesh-evidence-observer.js";
import { SessionMeshSendMessageKind } from "../src/main/session-mesh/session-mesh-send-message-relevance.js";
import {
  createMeshHarness,
  disposeMeshHarnesses,
  isPresencePost,
  type MeshRequest,
  meshDelivery,
  meshEvent,
  meshRepository,
  sessionEvent,
} from "./session-mesh-runtime-cov-iss11283-harness.js";

function isPublish(request: MeshRequest): boolean {
  return request.method === "POST" && request.path === "/session-mesh/messages";
}

function published(requests: MeshRequest[]) {
  return requests.filter(isPublish).map((request) => request.body);
}

function presences(requests: MeshRequest[]) {
  return requests.filter(isPresencePost).map((request) => request.body);
}

function promptEvent(prompt: string, sessionId = "session-1") {
  return sessionEvent("UserPromptSubmit", sessionId, { prompt });
}

const ARTIFACT_UUID = "019ef509-5774-7618-922c-753000d5f079";

function interactions(requests: MeshRequest[]) {
  return published(requests).filter(
    (body) =>
      typeof body?.context === "object" &&
      body.context !== null &&
      "interaction" in body.context
  );
}

function onBranch(
  harness: ReturnType<typeof createMeshHarness>,
  branch: string
) {
  harness.resolveWorkspace.mockImplementation((_cwd, file, files) =>
    Promise.resolve({
      repository: meshRepository,
      revision: "rev-1",
      paths: files ?? (file ? [file] : []),
      symbols: [],
      branch,
    })
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  disposeMeshHarnesses();
});

describe("Session Mesh artifact interaction instrumentation", () => {
  it("publishes a subject-bearing claim when a session says it is reviewing a pull request", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("review PR-8536 for me"));
    await runtime.whenIdle();
    const interaction = published(harness.requests).find(
      (body) => body?.context !== undefined
    );
    expect(interaction).toMatchObject({
      kind: SessionMeshSendMessageKind.Claim,
      context: { interaction: SessionMeshArtifactInteraction.Reviewing },
      recipientAgentIds: [],
    });
    // The whole point: a lifecycle publication carries `symbols: []`, so a
    // reviewing session had no routing key. This one does.
    expect(interaction?.workspace).toMatchObject({ symbols: ["PR-8536"] });
    expect(interaction?.lineage).toMatchObject({ pullRequest: "#8536" });
    expect(String(interaction?.summary)).toBe("Reviewing PR-8536");
  });

  it("publishes a found dependency as a discovery naming both artifacts", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(
      promptEvent("ISS-12167 is blocked by ISS-10797, confirm")
    );
    await runtime.whenIdle();
    const interaction = published(harness.requests).find(
      (body) => body?.context !== undefined
    );
    expect(interaction).toMatchObject({
      kind: SessionMeshSendMessageKind.Discovery,
      context: { interaction: SessionMeshArtifactInteraction.DependencyFound },
    });
    expect(interaction?.workspace).toMatchObject({
      symbols: ["ISS-12167", "ISS-10797"],
    });
    expect(String(interaction?.summary)).toBe(
      "Found dependencies: ISS-10797, ISS-12167"
    );
  });

  it("publishes no interaction for a prompt that names no artifact", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("review this and implement the fix"));
    await runtime.whenIdle();
    expect(
      published(harness.requests).filter((body) => body?.context !== undefined)
    ).toEqual([]);
  });

  it("re-publishes one subject set under a single idempotency key, so the server records one row", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("reviewing ISS-12167"));
    await runtime.handle(promptEvent("still reviewing ISS-12167"));
    await runtime.whenIdle();
    // The ledger's own dedupe only covers an operation still pending, so a
    // second turn naming the same subject does reach the wire. The key is what
    // collapses it: `publish` leaves `inserted.count` at 0 and creates no
    // deliveries (`apps/api/app/session-mesh/service.ts`).
    const keys = new Set(
      published(harness.requests)
        .filter((body) => body?.context !== undefined)
        .map((body) => String(body?.idempotencyKey))
    );
    expect(keys.size).toBe(1);
  });

  it("keys a different subject set separately", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("reviewing ISS-12167"));
    await runtime.handle(promptEvent("reviewing ISS-10797"));
    await runtime.whenIdle();
    const keys = new Set(
      published(harness.requests)
        .filter((body) => body?.context !== undefined)
        .map((body) => String(body?.idempotencyKey))
    );
    expect(keys.size).toBe(2);
  });

  it("retains a trace symbol and the pull request on a later turn that names neither", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("reviewing ISS-12167 on PR-8536"));
    await runtime.handle(promptEvent("what did we decide here"));
    await runtime.whenIdle();
    const latest = presences(harness.requests).at(-1);
    // Presence is a full overwrite on every event, so a symbol the session
    // declared on an earlier turn is only routable if it is carried forward.
    expect(latest?.workspace).toMatchObject({
      symbols: ["ISS-12167", "PR-8536"],
    });
    expect(latest?.lineage).toMatchObject({ pullRequest: "#8536" });
  });

  it("supersedes the pull request when the session moves to another one", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("reviewing PR-8536"));
    await runtime.handle(promptEvent("now reviewing PR-8540"));
    await runtime.whenIdle();
    const latest = presences(harness.requests).at(-1);
    expect(latest?.lineage).toMatchObject({ pullRequest: "#8540" });
    expect(latest?.workspace).toMatchObject({
      symbols: ["PR-8536", "PR-8540"],
    });
  });

  it("keeps accumulating paths, the retention this replaced", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_use_id: "t1",
        tool_input: { file_path: "a.ts" },
      })
    );
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_use_id: "t2",
        tool_input: { file_path: "b.ts" },
      })
    );
    await runtime.whenIdle();
    expect(presences(harness.requests).at(-1)?.workspace).toMatchObject({
      paths: ["a.ts", "b.ts"],
    });
  });

  it("never infers an explicit dependency, which would interrupt peers", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("ISS-1 is blocked by ISS-2"));
    await runtime.whenIdle();
    expect(presences(harness.requests).at(-1)?.lineage).toMatchObject({
      blocksArtifactIds: [],
    });
  });

  it("retains the trace identity across the Stop that ends every Claude turn", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("reviewing ISS-12167 on PR-8536"));
    await runtime.handle(sessionEvent("Stop"));
    await runtime.handle(promptEvent("continue"));
    await runtime.whenIdle();
    const latest = presences(harness.requests).at(-1);
    expect(latest?.workspace).toMatchObject({
      symbols: ["ISS-12167", "PR-8536"],
    });
    expect(latest?.lineage).toMatchObject({ pullRequest: "#8536" });
  });

  it("forgets the retained identity when the session ends", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("reviewing ISS-12167 on PR-8536"));
    await runtime.handle(sessionEvent("SessionEnd"));
    await runtime.handle(promptEvent("continue"));
    await runtime.whenIdle();
    const latest = presences(harness.requests).at(-1);
    expect(latest?.workspace).toMatchObject({ symbols: [] });
    expect(latest?.lineage).not.toHaveProperty("pullRequest");
  });

  it("drops a retained pull request once the session's branch changes", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    onBranch(harness, "fix/one");
    await runtime.handle(promptEvent("reviewing PR-8536"));
    await runtime.handle(promptEvent("continue"));
    await runtime.whenIdle();
    expect(presences(harness.requests).at(-1)?.lineage).toMatchObject({
      pullRequest: "#8536",
    });
    onBranch(harness, "fix/two");
    await runtime.handle(promptEvent("continue"));
    await runtime.whenIdle();
    expect(presences(harness.requests).at(-1)?.lineage).not.toHaveProperty(
      "pullRequest"
    );
  });

  it("publishes an interaction with this event's paths, not the retained ones", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_use_id: "t1",
        tool_input: { file_path: "a.ts" },
      })
    );
    await runtime.handle(promptEvent("reviewing PR-8536"));
    await runtime.whenIdle();
    expect(interactions(harness.requests).at(-1)?.workspace).toMatchObject({
      paths: [],
    });
  });

  it("keeps a retained subject off the SendMessage mirror and the edit claim", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(promptEvent("reviewing ISS-1 on PR-8536"));
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "SendMessage",
        tool_use_id: "t1",
        tool_input: { to: "sibling", summary: "finished ISS-2" },
      })
    );
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_use_id: "t2",
        tool_input: { file_path: "a.ts" },
      })
    );
    await runtime.whenIdle();
    const rows = published(harness.requests);
    const mirror = rows.find(
      (body) =>
        (body?.context as Record<string, unknown> | undefined)?.origin ===
        "native_send_message"
    );
    expect(mirror?.workspace).toMatchObject({ symbols: ["ISS-2"] });
    expect(mirror?.lineage).not.toHaveProperty("pullRequest");
    const claim = rows.find((body) => body?.summary === "Editing a.ts");
    expect(claim).toBeDefined();
    expect(claim?.lineage).not.toHaveProperty("pullRequest");
  });

  it("keys an interaction on the trace's own artifact ids, not retained ones", async () => {
    const retainedKey = async (first?: string) => {
      const harness = createMeshHarness();
      const runtime = harness.runtime();
      if (first) {
        await runtime.handle(promptEvent(first));
      }
      await runtime.handle(promptEvent("reviewing ISS-12167"));
      await runtime.whenIdle();
      const row = interactions(harness.requests).at(-1);
      expect(row?.lineage).toMatchObject({ artifactIds: [] });
      return row?.idempotencyKey;
    };
    expect(await retainedKey(`open documents/${ARTIFACT_UUID}`)).toBe(
      await retainedKey()
    );
  });

  it("draws a delivery's placebo from retained paths on a prompt turn", async () => {
    const recordDelivery = vi.spyOn(
      SessionMeshEvidenceObserver.prototype,
      "recordDelivery"
    );
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_use_id: "t1",
        tool_input: { file_path: "src/recipient-only.ts" },
      })
    );
    await runtime.whenIdle();
    harness.state.inboxFor = () => [
      meshDelivery({
        id: "0b9f5a52-7a4c-4b3e-9d61-1f7c2d0c9a01",
        recipientAgentId: "claude:session-1",
        summary: "Working src/shared.ts",
        relevance: { pathOverlap: ["src/shared.ts"] },
        paths: ["src/shared.ts"],
      }),
    ];
    // A prompt event resolves no paths of its own, so the placebo is only
    // reachable through the paths this session retained from its edit.
    await runtime.handle(promptEvent("continue"));
    await runtime.whenIdle();
    const context = await runtime.handle(sessionEvent("AwaitContext"));
    await runtime.handle(
      meshEvent("ContextDelivered", { receipt: context.receipt })
    );
    await runtime.whenIdle();
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ placebo: "src/recipient-only.ts" })
    );
  });
});
