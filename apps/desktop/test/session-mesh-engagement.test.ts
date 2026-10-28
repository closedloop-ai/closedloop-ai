import { afterEach, describe, expect, it } from "vitest";
import {
  engagementDispositions,
  SessionMeshEngagement,
} from "../src/main/session-mesh/session-mesh-engagement.js";
import {
  createMeshHarness,
  disposeMeshHarnesses,
  type MeshRequest,
  meshDelivery,
  sessionEvent,
} from "./session-mesh-runtime-cov-iss11283-harness.js";

const messageId = "1f2e3d4c-5b6a-4798-8899-aabbccddeeff";
const subjectPath = "apps/api/app/session-mesh/service.ts";

afterEach(() => {
  disposeMeshHarnesses();
});

function dispositions(requests: MeshRequest[]) {
  return requests
    .filter(
      (request) =>
        request.method === "POST" &&
        request.path === "/session-mesh/inbox/disposition"
    )
    .map((request) => request.body);
}

/** Deliver one message naming `subjectPath`, then return the live runtime. */
async function deliveredRuntime(
  harness: ReturnType<typeof createMeshHarness>,
  overrides: Parameters<ReturnType<typeof createMeshHarness>["runtime"]>[0] = {}
) {
  harness.state.inboxFor = () => [
    meshDelivery({
      id: messageId,
      recipientAgentId: "claude:session-1",
      summary: `Peer already owns ${subjectPath}`,
    }),
  ];
  const runtime = harness.runtime(overrides);
  const context = await runtime.handle(sessionEvent("SessionStart"));
  await runtime.whenIdle();
  const receipt = String(
    (await runtime.handle(sessionEvent("AwaitContext"))).receipt ??
      context.receipt ??
      ""
  );
  await runtime.handle(
    sessionEvent("ContextDelivered", "session-1", { receipt })
  );
  await runtime.whenIdle();
  return runtime;
}

describe("Session Mesh engagement", () => {
  it("records engagement as an acknowledged disposition when the session edits the delivered subject, adding no request but that one", async () => {
    const harness = createMeshHarness();
    const runtime = await deliveredRuntime(harness);
    expect(
      dispositions(harness.requests).filter(
        (body) => body?.status === "acknowledged"
      )
    ).toHaveLength(0);
    harness.state.inboxFor = () => [];
    const before = harness.requests.length;
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_use_id: "toolu_edit_1",
        tool_input: { file_path: `/repo/${subjectPath}` },
      })
    );
    await runtime.whenIdle();
    const acknowledged = dispositions(harness.requests).filter(
      (body) => body?.status === "acknowledged"
    );
    expect(acknowledged).toHaveLength(1);
    expect(acknowledged[0]).toMatchObject({ messageId });
    expect(String(acknowledged[0]?.reason)).toContain(subjectPath);
    // Engagement is purely textual. Any classification or enrichment call added
    // to `observe` would show up here as a request to some other path.
    expect(
      [
        ...new Set(
          harness.requests.slice(before).map((request) => request.path)
        ),
      ].sort()
    ).toEqual([
      // The claim publish and the presence/inbox poll are the pre-existing
      // lifecycle traffic. Anything else here would be a classification or
      // enrichment call added to `observe`, which must never happen.
      "/session-mesh/inbox",
      "/session-mesh/inbox/disposition",
      "/session-mesh/messages",
      "/session-mesh/presence",
    ]);
  });

  it("threads the resolved git toplevel into engagement, so an absolute path a Bash command named still matches", async () => {
    const harness = createMeshHarness();
    // A Bash command carries no `apply_patch` header, so `nativeFiles` yields
    // nothing: this path reaches matching only if the runtime hands engagement
    // the toplevel it resolved for the same event.
    const runtime = await deliveredRuntime(harness, {
      resolveWorkspace: () =>
        Promise.resolve({
          repository: "closedloop-ai/closedloop-ai",
          revision: "rev-1",
          paths: [],
          symbols: [],
          root: "/repo",
        }),
    });
    harness.state.inboxFor = () => [];
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Bash",
        tool_use_id: "toolu_bash_1",
        tool_input: { command: `pnpm vitest run /repo/${subjectPath}` },
      })
    );
    await runtime.whenIdle();
    expect(
      dispositions(harness.requests).filter(
        (body) => body?.status === "acknowledged"
      )
    ).toMatchObject([{ messageId }]);
  });

  it("leaves a delivery the session never touched as delivered and not engaged", async () => {
    const harness = createMeshHarness();
    const runtime = await deliveredRuntime(harness);
    harness.state.inboxFor = () => [];
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_use_id: "toolu_edit_2",
        tool_input: { file_path: "/repo/docs/unrelated.md" },
      })
    );
    await runtime.whenIdle();
    expect(
      dispositions(harness.requests).filter(
        (body) => body?.status === "acknowledged"
      )
    ).toHaveLength(0);
    expect(
      dispositions(harness.requests).some(
        (body) => body?.status === "delivered"
      )
    ).toBe(true);
  });

  it("asks for a value disposition exactly once per engaged message", () => {
    let now = 1000;
    const engagement = new SessionMeshEngagement({ now: () => now });
    engagement.recordDelivery({
      sourceKey: "source",
      agentId: "claude:a",
      messageId,
      summary: `Peer owns ${subjectPath}`,
      paths: [],
    });
    expect(
      engagement.observe({
        sourceKey: "source",
        agentId: "claude:a",
        files: [`/repo/${subjectPath}`],
        text: "",
      })
    ).toHaveLength(1);
    now += 1;
    // A second observation of the same subject is not a second engagement.
    expect(
      engagement.observe({
        sourceKey: "source",
        agentId: "claude:a",
        files: [`/repo/${subjectPath}`],
        text: "",
      })
    ).toHaveLength(0);
    const asked = engagement.pendingPrompts("source", "claude:a");
    expect(asked).toHaveLength(1);
    // Composing a prompt is not asking it, so it stays pending until the hook
    // confirms the context reached the model.
    expect(engagement.pendingPrompts("source", "claude:a")).toHaveLength(1);
    engagement.markPrompted("source", "claude:a", asked);
    expect(engagement.pendingPrompts("source", "claude:a")).toHaveLength(0);
  });

  it("matches a ticket slug the delivered summary named", () => {
    const engagement = new SessionMeshEngagement({ now: () => 0 });
    engagement.recordDelivery({
      sourceKey: "source",
      agentId: "claude:a",
      messageId,
      summary: "Peer is rewriting ISS-11435 reporting",
      paths: [],
    });
    expect(
      engagement.observe({
        sourceKey: "source",
        agentId: "claude:a",
        files: [],
        text: "working on ISS-11435 now",
      })
    ).toMatchObject([{ messageId, subject: "ISS-11435" }]);
  });

  it("tracks nothing for a delivery that names no subject, so no later tool use reads as engagement", () => {
    const engagement = new SessionMeshEngagement({ now: () => 0 });
    engagement.recordDelivery({
      sourceKey: "source",
      agentId: "claude:a",
      messageId,
      summary: "peer started",
      paths: [],
    });
    expect(
      engagement.observe({
        sourceKey: "source",
        agentId: "claude:a",
        files: ["/repo/anything.ts"],
        text: "",
      })
    ).toHaveLength(0);
  });

  it("builds one idempotent acknowledged disposition per engaged message", () => {
    expect(
      engagementDispositions("claude:a", [
        { messageId, subject: subjectPath, evidence: `/repo/${subjectPath}` },
      ])
    ).toMatchObject([
      {
        id: `engaged:claude:a:${messageId}`,
        body: { agentId: "claude:a", messageId, status: "acknowledged" },
      },
    ]);
  });

  it("abandons an operation the cloud rejects as invalid instead of retrying it", async () => {
    const harness = createMeshHarness();
    harness.state.respond = (request) =>
      request.path === "/session-mesh/inbox/disposition"
        ? new Response(JSON.stringify({ success: false }), { status: 400 })
        : undefined;
    // An older server rejecting a shape it does not know must not wedge the queue
    // behind bytes that can never be accepted.
    await deliveredRuntime(harness);
    expect(
      harness
        .ledger()
        .operations.filter((row) =>
          row.path.includes("/session-mesh/inbox/disposition")
        )
    ).toHaveLength(0);
    expect(
      harness.logs.some((line) =>
        line.includes("abandoned an operation after its one attempt")
      )
    ).toBe(true);
  });
});

describe("Session Mesh engagement bounds and matching", () => {
  it("does not match a delivered bare filename against a same-named file elsewhere", () => {
    const engagement = new SessionMeshEngagement({ now: () => 0 });
    engagement.recordDelivery({
      sourceKey: "source",
      agentId: "claude:a",
      messageId,
      summary: "peer owns it",
      paths: ["index.ts"],
    });
    expect(
      engagement.observe({
        sourceKey: "source",
        agentId: "claude:a",
        files: ["packages/other/index.ts"],
        text: "",
      })
    ).toHaveLength(0);
  });

  it("does not treat a session relaying the delivered summary as engagement", async () => {
    const harness = createMeshHarness();
    const runtime = await deliveredRuntime(harness);
    harness.state.inboxFor = () => [];
    // The Mesh context block is already in this session's context, so quoting
    // the subject back to a sibling must not count as working on it.
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "SendMessage",
        tool_use_id: "toolu_relay_1",
        tool_input: {
          to: "peer",
          summary: "Relaying the mesh note",
          message: `FYI a peer already owns ${subjectPath}`,
        },
      })
    );
    await runtime.whenIdle();
    expect(
      dispositions(harness.requests).filter(
        (body) => body?.status === "acknowledged"
      )
    ).toHaveLength(0);
  });

  it("does not retain an entry for an agent that was only asked about", () => {
    const engagement = new SessionMeshEngagement({ now: () => 0 });
    for (let index = 0; index < 900; index += 1) {
      engagement.observe({
        sourceKey: "source",
        agentId: `claude:${index}`,
        files: ["a/b.ts"],
        text: "",
      });
    }
    // Nothing was delivered to any of them, so nothing may be tracked.
    expect(engagement.pendingPrompts("source", "claude:0")).toHaveLength(0);
  });
});

describe("Session Mesh engagement observation scope", () => {
  it("matches a Windows-separated tool path against a repository-relative subject", () => {
    const engagement = new SessionMeshEngagement({ now: () => 0 });
    engagement.recordDelivery({
      sourceKey: "source",
      agentId: "claude:a",
      messageId,
      summary: `Peer owns ${subjectPath}`,
      paths: [],
    });
    // Delivered paths are always `/`-separated; a Windows tool path is not.
    expect(
      engagement.observe({
        sourceKey: "source",
        agentId: "claude:a",
        files: [String.raw`C:\repo\apps\api\app\session-mesh\service.ts`],
        text: "",
      })
    ).toMatchObject([{ messageId }]);
  });

  it("does not read a ticket slug out of edited content", () => {
    const engagement = new SessionMeshEngagement({ now: () => 0 });
    engagement.recordDelivery({
      sourceKey: "source",
      agentId: "claude:a",
      messageId,
      summary: "Peer is rewriting ISS-11435 reporting",
      paths: [],
    });
    // Nearly every comment in this repo cites a slug, so scanning `new_string`
    // would make writing any such comment read as engagement.
    expect(
      engagement.observe({
        sourceKey: "source",
        agentId: "claude:a",
        files: [],
        text: "",
      })
    ).toHaveLength(0);
  });

  it("relativizes an absolute path a tool named against the workspace root, so it matches a repository-relative subject", () => {
    const engagement = new SessionMeshEngagement({ now: () => 0 });
    engagement.recordDelivery({
      sourceKey: "source",
      agentId: "claude:a",
      messageId,
      summary: `Peer owns ${subjectPath}`,
      paths: [],
    });
    // A Bash command is not an `apply_patch` header, so `nativeFiles` yields
    // nothing and this absolute path reaches matching ONLY through the text
    // extractor. Without the root it fails the prefix test and is dropped.
    expect(
      engagement.observe({
        sourceKey: "source",
        agentId: "claude:a",
        files: [],
        text: `pnpm vitest run /repo/${subjectPath}`,
        workspaceRoot: "/repo",
      })
    ).toMatchObject([{ messageId, subject: subjectPath }]);
  });

  it("drops an absolute path outside the workspace root rather than matching another checkout", () => {
    const engagement = new SessionMeshEngagement({ now: () => 0 });
    engagement.recordDelivery({
      sourceKey: "source",
      agentId: "claude:a",
      messageId,
      summary: `Peer owns ${subjectPath}`,
      paths: [],
    });
    expect(
      engagement.observe({
        sourceKey: "source",
        agentId: "claude:a",
        files: [],
        text: `pnpm vitest run /other-checkout/${subjectPath}`,
        workspaceRoot: "/repo",
      })
    ).toHaveLength(0);
  });

  it("reports the delivered subject, not the raw tool path, as the disposition reason", () => {
    expect(
      engagementDispositions("claude:a", [
        {
          messageId,
          subject: subjectPath,
          evidence: `/Users/alice/repo/${subjectPath}`,
        },
      ])[0]?.body.reason
    ).toBe(`Observed work touching ${subjectPath} after delivery`);
  });
});
